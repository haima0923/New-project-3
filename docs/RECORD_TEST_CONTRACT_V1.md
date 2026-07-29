# 记一笔第一阶段测试合同（V1）

> 状态：**合同已定稿；Release A RC1 的生产 Legacy 事务基础设施候选已通过离线与
> 微信开发者工具隔离验证；production 固定 `LEGACY_ONLY`，共享生产 Commit 仍禁用；
> 尚未上传或发布，没有真实用户 canary、可信远程 kill switch、客户端覆盖率、真机或
> 真实 AI 验证。**
>
> 本合同与 `docs/RECORD_SHARED_CORE_CONTRACT.md` 配套。任何测试成绩都必须能说明：测的是哪份代码、哪套题、哪种模式、哪个模型和 prompt，以及错误发生在哪一层。

## 1. 权威范围

本文件是记一笔第一阶段自动测试的权威合同，定义：

- 每条测试题和历史 fixture 的结构；
- 从严格原文到 MemoryStore `stateDiff` 的执行方式；
- 三种模式、AI 异常模拟和保存副作用断言；
- 五层评分、错误归属、零容忍门禁和质量指标；
- 报告、真实 AI canary、环境隔离和后续测试边界。

它不替代生产代码，也不允许测试运行器自行复制 parser、路由、合并、安全或保存逻辑。

### 1.1 Phase 1A 动态验证状态（2026-07-22）

`scripts/record-shared-core-phase1a-tests.js` 当前包含 25 组确定性测试，从 `originalText` 调用真实本地 parser 和真实 route，AI 路径只使用 fake/mock/replay 或本机 fake `wx.request`。覆盖：

- 统一状态和旧值映射、未知值 fail closed；
- local/pending AI 零调用，standard/deep 单次调用；
- 请求状态、业务 outcome、采用状态和 canonical/raw 错误码分离；
- 空业务 JSON、timeout、网络/鉴权/provider 失败、mock 身份和无 endpoint；
- 多商品与聊天 `pasteMeta/rawMessages/selectedMessages` 保留；
- 严格原文、trace 隔离、JSON 序列化和基础凭证脱敏；
- Phase 1A 起始 HEAD `3608a1281d52b8bfa4594b998cbd27d33f17d563` 的 11 类完整关键结果金样本；除运行日期生成的 `quoteDate` 外，字段、items、缺失、低置信、冲突、安全、route、AI outcome 和遗留原文均纳入冻结哈希。

同轮还通过 `ai-safety-regression-tests.js`、`parse-route-observability-tests.js`、`five-step-user-tests.js` 和 `core-feature-tests.js`。所有命令均清除了 AI 环境变量，没有调用真实 AI、生产 endpoint 或生产数据。

Phase 1A 当时还不是完整 V1 runner：尚无 LOCAL_ONLY/AI_ONLY 执行、FrozenClock、固定业务 ID、统一领域 confirmation、savePlan、MemoryStore、state diff、五层报告或页面接入。前两项中的模式执行和业务时间/trace ID 已分别由 Phase 1C、1B 补齐，其余限制仍然存在。Phase 1A trace 仅允许内存使用；完整生产脱敏策略未实现。现有保存入口也尚未消费新门面的严格 `originalText`，所以不能把本轮测试写成“最终业务持久化原文合同已验证”。

### 1.2 Phase 1B 动态验证状态（2026-07-22）

对应代码与测试提交：`3688cef1463b021fb091272a3a5f52f52c0c6c95`。

`scripts/record-shared-core-phase1b-tests.js` 当前包含 24 组离线确定性测试，覆盖：

- 默认且唯一正式支持的 `Asia/Shanghai` 业务时区，以及 UTC、洛杉矶系统时区下相同注入时刻的稳定结果；
- 显式业务日期、上海午夜前后、UTC 仍为前一天、跨年、下周五、本月底、下月底和三天后；其中测试只冻结当前 parser 语义，不借 Phase 1B 重定义日期产品规则；
- 非法日期、非法时区、非法时刻、日期/时刻不一致、非法 clock、倒退 clock、空 ID 和同次运行重复 ID 的 fail-closed 行为；
- 固定 `runId`、`traceId`、AI `requestId` 贯穿 core/adapter/trace；成功与 HTTP 失败时，客户端 `requestId` 和服务端 `serverRequestId` 分开记录，`providerRequestId` 不伪造；
- 旧 `parseHybridInput()` 的 standard/deep 入口在一次运行中固定同一业务日期，旧页面形态不再发送空 `businessDate`；
- standard/deep prompt 使用同一业务日期，服务端缺省按上海日期而非 UTC 截断，非法日期在 fake provider 前被拒绝；
- 根目录与 server 的 parser/date/safety/runtime 镜像一致、独立复制 `server/` 后模型模块可加载；1,490 题 fixture 与正式 runner 已完成固定日期接线，专项测试验证题数、fixture 字段和 runner 接线，本轮未生成报告或全量重跑 1,490 题。

同轮通过 Phase 1A 25/25、P0 AI 安全、route/等待、五步用户、核心功能、AI 模型路由和服务端 parse route 离线回归。所有 AI 环境变量均显式清除；只使用 fake/mock/内存数据和本机回环 fake 服务，没有调用真实 AI、生产 endpoint 或生产数据。

Phase 1B 的确定性范围是业务日期、共享 trace 计时和 `runId/traceId/AI requestId`。遗留 parser 的 `parse_*` ID/`createdAt`、旧 AI 等待预算的系统计时、正式业务记录 ID、保存时间及全仓旧测试中的动态日期仍未迁移，因此不能写成“完整解析输出和所有测试已经完全冻结”。页面仍未切换到共享门面，微信运行时和真实 AI 均未验证。

### 1.3 Phase 1C 动态验证状态（2026-07-22）

对应代码与测试提交：`c5821efe5ac4af4a1414f102928472a11f5186ad`。

`scripts/record-shared-core-phase1c-tests.js` 当前包含 16 组离线确定性测试，覆盖：

- 三种合法 mode、兼容默认生产模式和显式非法 mode fail closed；三种 `resultScope` 与模式/生产资格不混淆。
- LOCAL_ONLY 在 local、pending、standard、deep、金融和多商品 productionRoute 下 adapter 调用始终为 0，同时仍记录真实 parser、安全与生产 route。
- AI_ONLY 的 `localDraft=null`、request 中不传影子 productionRoute，standard/deep 仅由 `reviewMode` 决定；本地客户、商品、数量、金额、缺失项和 route 不进入最终 AI_ONLY 结果或确认摘要。
- AI_ONLY 影子本地阶段即使失败也继续调用 adapter；最终只使用统一 AI 有效性检查和标准化，`merge.performed=false`。
- 空业务、非 JSON、401、403、500、网络错误、超时、缺 adapter、非法身份和不支持 deep 均 fail closed；有效不确定、NO_RECORD、缺字段和 deep 多商品不被空结果规则误伤。
- FAKE/MOCK/REPLAY 返回 JSON 不能伪造 REAL，模型返回对象不能伪造 transport 事件；REPLAY 的真实延迟、成本和真实调用统计标记不适用，MOCK/FAKE/REPLAY 不获得真实存储资格。
- PRODUCTION_ROUTING 的 local、pending、standard、deep、timeout、401、空业务、mock、多商品、聊天和历史引用保持当前 route、合并与 P0 行为；Phase 1A 的 11 类起始 HEAD 金样本仍通过。
- 连续及共用同一 adapter 的跨模式运行没有 trace、结果或调用计数污染。

同轮通过 Phase 1A 25/25、Phase 1B 24/24、P0 AI 安全、route/等待、五步用户 28/28、核心功能、AI 模型路由和服务端 standard/deep mock 回归。所有命令显式清除 AI 环境变量；只使用 fake/mock/replay/内存数据及本机回环 fake 服务，没有调用真实 AI、生产 endpoint 或生产数据。

这仍不是完整 V1 runner：尚无共享领域 confirmation、savePlan、MemoryStore、state diff、五层统一报告、页面接入或真实业务保存副作用；AI_ONLY 的资格仅用于模式评分，不能冒充生产正式保存结论。REAL provider、真实 AI 质量、微信运行时和真机均未验证。

### 1.4 Phase 1D 动态验证状态（2026-07-22）

Phase 1D 新增两组离线确定性门禁：

- `scripts/record-shared-core-phase1d-tests.js`：16/16，覆盖 Confirmation schema、业务字段、缺失/冲突、危险字段、多商品、AI状态、三种mode、domain/surface、候选、revision/hash、兼容summary、页面事实对照和无存储副作用。
- `scripts/record-domain-preflight-tests.js`：20/20，覆盖28类关系/金额/目标矩阵，以及未知operation、pending、未完成AI、未知provider、LOCAL_ONLY/AI_ONLY/FAKE/MOCK/REPLAY进入business、近似/重名客户、强制新建、关系ID消费白名单、催款与待收关联、收款方向、待收/订单金融历史对账、作废/重复报价、精确重放收款/定金、AI控制字段伪造、报价转订单双向关系、五方一致性和正式副作用零增量。

专项测试明确检查：

- 同一规范草稿的 preflight、Confirmation、完整页、首页和 business 五方领域布尔值及 `preflightFingerprint` 一致；首页只允许因 surface 能力进一步禁用按钮。
- 阻断在正式写入前发生，客户、报价、订单、待收、收款和提醒增量均为0；待整理保留严格原文。
- 允许场景保存的类型、客户/关系、`originalText` 与完整 `items[]` 正确；部分收款和正好结清按选中待收更新，报价转订单在根目录/server 镜像中均保持双向关系。
- Confirmation 不信任调用方伪造的 preflight，而会把当前 result/state 重新绑定到权威纯规则；模型返回的provider标签不能自证REAL。

同轮 Phase 1A 25/25、Phase 1B 24/24、Phase 1C 16/16、AI P0、route、五步用户28/28、核心功能、金融生命周期、模型路由和服务端standard/deep mock回归均通过。未调用真实AI、外网或生产存储。

Phase 1D仍不是完整第一阶段runner：当前副作用回归直接使用隔离的普通内存state，并非通用MemoryStore/stateDiff框架；页面只有限接入领域安全布尔值，尚未迁移共享解析与完整Confirmation展示；用户编辑后的重算、savePlan、事务回滚和五层报告仍待后续实现。

### 1.5 Phase 1E.1 动态验证状态（2026-07-22）

`scripts/record-shared-core-phase1e1-tests.js` 当前为20/20，覆盖：

- SavePlan纯度、Confirmation/Preflight/state绑定、稳定planHash、明确formal/pending动作和默认不生成计划；
- 22个`saveConfirmedDraft()`/`savePendingNote()`代表场景的隔离全state等价，包括新/已有客户、订单、报价、记一笔关联报价建单、更新、按订单待收、待收+首付款、部分/结清收款、定金、提醒、催款、待整理、多商品无顶层总额、目录缺失回填和100条解析日志截断；
- MemoryStore深拷贝、版本/指纹隔离，客户、主记录、金融、日志、最终不变量及atomic swap前的失败注入完整回滚；
- 同计划幂等、planId/幂等键碰撞、过期计划、临时ID依赖、LINK、操作schema、用户授权、非MemoryStore和危险对象fail-closed；
- business/full diff 的created/updated/deleted、changedFields、顺序、meta、模板和额外顶层状态；严格`originalText`和完整`items[]`；跨客户金融关系、收款增量、既有payment不可变及定金上限。

该等价范围只指记一笔现有`saveConfirmedDraft()`/`savePendingNote()`入口。报价页直接`convertQuotationToOrder()`和订单页直接`generateReceivableFromOrder()`只锁定旧生命周期边界，尚未迁移或宣称SavePlan等价；后者既有直接路径也不在本轮“记一笔严格原文”结论内。

同轮Phase 1A～1D、领域预检、AI P0、route、五步用户、核心/金融生命周期、模型路由、UI结构和服务端fake回归均为0失败。全部命令清除AI环境变量；服务端测试只使用本机回环fake server，没有调用真实AI、外网、生产数据或微信Storage。

Phase 1E.1仍不是生产保存迁移：页面和现有business继续走旧保存入口；当时没有微信Storage adapter、统一五层报告、用户编辑后重算、真实AI或微信运行时验证。Phase 1E.2A只补只读adapter与影子证据；Phase 1E.2B才负责在事务条件满足后接入共享SavePlan和Commit。

### 1.6 Phase 1E.2A 动态验证状态（2026-07-22）

`scripts/record-shared-core-phase1e2a-tests.js` 当前为13/13，覆盖：

- 真实拓扑只有一个业务 bundle key；登录态和五个页面交接/偏好 key 明确排除，bundle 内15类已知路径及未知兼容字段进入稳定投影；没有独立持久化的records索引。
- Storage gateway和adapter身份由私有注册表保护；普通对象不能伪造WX，FAKE不能升级为生产target，调用者伪造、跨adapter或过期snapshot均fail closed。
- `previewCommit()`在MemoryStore中执行共享计划，返回business/full diff和单bundle proposedWrites；所有用例gateway写入/删除次数为0，`commit()`在任意迁移mode和失败注入下都返回`SHARED_PRODUCTION_COMMIT_DISABLED`。
- Phase 1E.1的22个代表场景分别经过fake-wx legacy保存/重载与共享投影/Preview/反投影；ID按既有等价合同规范化后，13个业务/审计集合、meta、dunningTemplates及兼容顶层状态完整等价，`fullDiff`与Memory commit一致。
- 未知客户/报价/订单/待收字段保留；原本不存在且未变化的productCatalog、operationLogs、deletedRecords不会被反投影凭空物化；登录态/页面key变化不使计划过期，业务、日志或目标状态变化会使旧计划失效。
- 源码静态检查确认当前有23处生产业务bundle写入调用，并按文件、调用种类和文件内序号逐点绑定到生命周期；6个非业务key的生产者/消费者也与源码静态核对，且全`pages/utils`扫描未发现清单外直接Storage字面量key。报价转单、订单生成待收、直接收款/催款、订单进度、提醒完成和软删除只做代表性边界验证，其余入口明确标为尚未迁移，不以清单存在冒充SavePlan等价。

原子性结论是“单bundle应用级替换，但微信持久化原子性未验证”。当前没有持久化revision/CAS、写后读回、journal、恢复协议或receipt；app启动和多个legacy writer仍可能覆盖新状态。因此本阶段只证明投影、Preview和隔离等价，不能作为Phase 1E.2B切换依据。未调用真实AI、外网、真实用户数据或真实微信Storage。

### 1.7 Phase 1E.2A.1 动态验证状态（2026-07-23）

`scripts/record-shared-core-phase1e2a1-tests.js` 当前为22/22，验证范围是受保护Fake Gateway和显式`TRANSACTION_PREVIEW`，不包含真实微信Storage：

- 静态逐点核对23个业务bundle writer，全部进入根`utils/storage.js`与`record-storage-coordinator`；server镜像委托根门面，app初始化使用明确入口，当前树没有直接写业务key的旁路。production模式仍硬编码`LEGACY_ONLY`，`SHARED_COMMIT`在coordinator和adapter两层均零写入拒绝。
- 旧bundle无revision时兼容读取并确定性迁移；未知meta、记录字段、缺失可选集合、删除记录、商品目录和较大bundle不丢失。事务控制槽从DomainState、diff、登录态和页面交接key中排除。
- revision/baseFingerprint双CAS覆盖两个writer同base、最终主写前外部变化、队列按最新state串行和同plan并发点击；stale writer不覆盖，重复plan只提交一次，planId异内容碰撞阻断。
- 事务按容量预检、sealed backup、两阶段journal、主bundle、立即读回、receipt和清理执行。11个崩溃检查点经adapter重建恢复后均落在完整旧态或完整目标态；合法未知外部态不被backup覆盖，而是保留材料并`STORAGE_RECOVERY_REQUIRED`。
- 16类读取、写入、静默不写、损坏、截断和清理故障均验证最终state、revision、receipt和事务材料；持续清理失败保留backup，故障解除后可幂等完成恢复。容量未知或不足在任何journal/backup/主bundle写入前阻断。
- 700次提交验证receipt账本上限：最近128条完整receipt、最多512条tombstone、至少64条高风险金融记录优先保留；保留窗口内的旧plan在重启后仍返回`ALREADY_COMMITTED`且零写入。测试同时明确：淘汰窗口外的无限期金融幂等尚未解决。
- Phase 1E.2A的22个业务场景再次比较`Legacy final business state == Shared Memory final state == Transactional target bundle`，业务差异0；事务meta、固定测试时间/ID之外不得豁免客户、金额、关系、items、originalText、状态、日志或目录差异。

同轮Phase 1E.2A 13/13、Phase 1E.1 20/20、Phase 1D 16/16、领域预检20/20、Phase 1C 16/16、Phase 1B 24/24、Phase 1A 25/25，以及AI P0、route、五步用户、本地硬检查、核心/金融、UI结构、模型路由、服务端fake/auth回归均通过。测试使用合成state；服务端测试仅用本机回环fake server。未调用真实AI、外网、真实用户数据或真实微信Storage。

这些结果不证明真实设备持久化原子性。真实wx gateway的缺key、配额、崩溃落盘、copy-on-write空间和跨页面/跨上下文writer排他仍需微信开发者工具隔离验证；当前hash用于非恶意损坏检测，不是密码学认证。生产共享Commit和app启动自动恢复保持禁用，不能据此建立发布结论。

### 1.8 Phase 1E.2A.2-R1 动态验证状态（2026-07-23）

`scripts/record-shared-core-phase1e2a2-static-tests.js` 为19/19；微信开发者工具直接首次打开仓库外独立 Mini Program 后完成真实 wx Storage 隔离验证：

- 独立入口不加载生产 `app.js`、onboarding、`initializeState()` 或业务页面；运行时代码在其他模块执行前安装四 key 硬白名单。生产工程忽略独立入口和运行时专用源码，正式 `app.json` 不暴露测试页面。
- 首次启动加五次真实“重新进入小程序”共记录6个不同Boot。整轮append-only审计中，真实业务key读取0、写入0、删除0，白名单外访问0。
- 不重载矩阵15/15通过：基础写入读回、旧bundle兼容、正常CAS、stale writer、无关key、planId碰撞、容量预检、真实coordinator队列和四类写后读回异常均符合合同。
- 五类跨Boot场景全部通过：`PREPARED → RECOVERED_ROLLED_BACK`；主bundle已写 → `RECOVERED_COMMITTED`；主bundle损坏且backup有效 → `RECOVERED_ROLLED_BACK`；矛盾材料 → `RECOVERY_REQUIRED`；同plan跨Boot → `ALREADY_COMMITTED`，异内容同planId → `SAVE_PLAN_ID_COLLISION`。
- 容量题读取真实 `wx.getStorageInfoSync()`，不足情形用gateway测试限额在主写入前阻断；没有填满开发者工具Storage。最终清理显示revision 0、receipt 0、test key count 0，四个隔离key均删除。
- 同轮离线门禁继续通过；未调用真实AI、外网、真实用户数据或真实业务key。production仍为`LEGACY_ONLY`，`SHARED_COMMIT`保持禁用。

本结果只证明微信开发者工具隔离key上的运行时行为，不证明真机断电、真实设备持久化绝对原子、真实用户数据迁移、跨进程原子CAS或生产保存切换。下一阶段只能设计带回退、监测和失败降级的受控切换方案，不能直接启用。

### 1.9 Phase 1E.2B.1 动态验证状态（2026-07-23）

`scripts/record-shared-core-phase1e2b1-tests.js` 为 12/12，验证范围为纯控制面和隔离存储演练：

- 可信配置使用私有注册身份；生产构建始终硬收敛为 `LEGACY_ONLY`。页面参数、普通 Storage、环境变量、克隆对象和普通布尔证据均不能开启 Shared；Shadow抽样未命中或采样率为0时不运行预演，配置也不能打开远程监测上传。
- `LEGACY_ONLY`、`SHADOW_PREVIEW`、`SHARED_CANARY`、`SHARED_PRIMARY`、`RECOVERY_LOCKED` 五种决策态均受检；后三种 Shared 决策只接受受保护 Fake/Memory/开发者工具隔离目标，不能绑定真实业务 Storage。
- Shared 资格逐项覆盖构建版本/flavor、Storage schema、事务协议、实际 Coordinator schema、target绑定、恢复材料、业务和操作 allowlist、Preflight、Confirmation、完整 SavePlan、state revision/fingerprint、provider/resultScope、Shadow 差异、Release A/旧 writer 退出和精确匹配的可信 canary cohort。
- 阶段化回退验证了安全写前、Backup/Journal、主 Bundle 可能写入、readback/receipt 不确定、stale、plan 碰撞、已提交和 Recovery Lock；主 Bundle 或提交结果一旦可能变化，Legacy 执行次数恒为 0。回退证明必须由绑定可信 Coordinator 的受保护 outcome 提供，普通布尔值不能解锁；可信配置为 `NO_FALLBACK` 时控制器不会自行改成写前回退。
- 可信 evidence 的 transaction/recovery 状态优先于普通输入；普通输入试图把 `COMMITTED + RECOVERY_REQUIRED` 改报为 `ROLLED_BACK + RECOVERED_ROLLED_BACK` 时进入 Recovery Lock，不得借已验证回滚路径执行 Legacy。
- 22 个既有 Legacy/Shared 等价场景继续作为 Shadow 基线；业务、金融、关系、数据丢失、未知差异和自相矛盾的 Shadow 结果均阻断 Shared。
- `Legacy → Shared → 事务兼容 Legacy → Shared` 只在同一事务协议的隔离状态机中做模式转换模拟，验证 revision、receipt、未知字段和关系语义；不代表生产 transactional Legacy writer 已接入。
- 监测仅保留严格枚举和短指纹，输入中的原文、客户、电话、商品、金额、自由错误文字和完整业务对象不能进入内部事件、公开 decision 的 `monitoringEvents` 或 `monitoringTags`；内存 FIFO 有界、可清理且不上传。
- Kill switch 只影响下一笔未开始保存；`RECOVERY_LOCKED`、已提交、stale、plan碰撞和模糊事务状态不能被 kill switch 改道到 Legacy。

同轮 Phase 1E.2A.2 静态门禁 19/19、Phase 1E.2A.1 22/22、Phase 1E.2A 13/13、Phase 1E.1 20/20、Phase 1D 16/16、领域预检 20/20、Phase 1C 16/16、Phase 1B 24/24、Phase 1A 25/25，以及 AI P0、route、五步用户、本地硬检查、核心/金融、UI结构、模型路由、服务端 fake/auth 回归均通过。控制面没有修改 Transaction、Journal、Recovery、Storage Gateway 或 Runtime Harness，因此本轮没有重跑真实微信 Storage 矩阵；沿用 Phase 1E.2A.2-R1 的隔离运行时证据。

当前没有可信远程配置或客户端版本覆盖率，只能通过构建配置和发布新版本进行全局回退，不能称为在线一键 kill switch。production 仍为 `LEGACY_ONLY`，共享生产 Commit 和真实用户 canary 均未启用。

### 1.10 Release A RC1 动态验证状态（2026-07-23）

`scripts/record-release-a-rc1-tests.js` 当前为 16/16，覆盖：

- 23 个物理业务 Bundle writer 与 20 类生命周期逐点绑定受控
  `writerSource`，生产代码没有直接写或删除真实业务 key 的旁路；
- 生产 Coordinator 身份固定 `LEGACY_ONLY`、事务 Legacy 保护启用而 Shared API
  继续拒绝；页面参数、普通配置和 Shared 请求不能提升生产模式；
- 已有有效 Bundle 启动零写入；无 Bundle 时只通过 Coordinator 初始化一次；
  PREPARED、目标主 Bundle、有效 Backup 和矛盾材料恢复顺序均先于初始化；
- 22 个代表场景按同一初始 state 比较旧 Legacy、Shared Memory 和事务 Legacy，
  客户、报价、订单、待收、付款、提醒、待整理、原文、items、关系、日志和目录业务
  差异为 0；
- 两个页面读取同一 base 时 A 提交成功、B 同步返回 `LEGACY_SAVE_STALE` 且不覆盖；
  顺序 mutation 每次重读最新 state，失败后临界区可继续使用；
- transaction manager 已确认提交后不再做会误报失败的附加读取；已消费 state 不能
  重新绑定到后续 Bundle 或覆盖新数据；
- 容量不足在主 Bundle 写入前阻断；readback 损坏不返回成功，回滚后后续 writer
  仍可工作；损坏恢复材料统一分类为 `LEGACY_SAVE_RECOVERY_REQUIRED`，Recovery Lock
  阻断全部业务 Bundle writer；
- 无 meta、未知 meta、未知顶层/记录字段和缺少可选集合的旧 Bundle 无损；首次业务
  写入确定性建立 revision，纯启动不强制升级；
- Receipt 有界、revision 单调递增；收款、结清、定金、报价转订单、软删除、多商品
  和严格原文均保持单次副作用；
- 本地监测有界、脱敏、不持久化、不上传，监测自身失败不影响保存；
- 低层 Release A transaction manager 不导出；平台组合根只能取得完整 Coordinator；
  生产写入缺少明确 `writerSource` 时 fail closed；
- 构建门禁确保 runtime test 不进入生产页面，Shared 不可达且没有报告、快照或临时
  绝对路径进入候选。

同轮 Phase 1E.2B.1 12/12、Phase 1E.2A.2 静态门禁、Phase 1E.2A.1
22/22、Phase 1E.2A 13/13、Phase 1E.1 20/20、Phase 1D 16/16、领域预检
20/20、Phase 1C 16/16、Phase 1B 24/24、Phase 1A 25/25，以及 AI P0、
route、五步用户、本地硬检查、核心/金融、UI、模型路由和服务端 fake/auth 回归均
通过。微信候选矩阵只使用仓库外独立 Mini Program 和四个隔离 key：当前 RC 物化
20 个文件，不重载测试 16/16；PREPARED、主 Bundle 已写、Backup、矛盾状态和幂等
五类场景均经过真实重新编译进入新 App 实例后验证。整轮累计 6 个审计 Boot，真实
业务 key 读/写/删均为 0、白名单外访问为 0，最终 revision、Receipt 和测试 key
数量均清理为 0。

这些测试证明候选代码的应用级事务、恢复和 Legacy 语义，不证明真机断电、真实设备
持久化绝对原子、真实用户迁移或旧客户端已退出。Release A 尚未上传或发布，Shared
生产 Commit 和真实用户 canary 均未启用。

## 2. 第一阶段范围

### 2.1 必须覆盖

```text
严格原始文字
  ↓
共享输入/聊天提取
  ↓
真实本地 parser
  ↓
真实 route 决策
  ↓
fake/mock AI（按测试场景）
  ↓
真实 AI 标准化与合并函数
  ↓
真实安全规则
  ↓
共享领域 confirmation
  ↓
真实 savePlan 生成
  ↓
MemoryStore commit
  ↓
stateBefore / stateAfter / stateDiff
```

每条主链题必须从 `originalText` 开始。允许单独的纯函数单元测试补充边界，但单元测试不能代替主链门禁，也不能只构造 `parseResult` 或 `fields` 就声称“完整记一笔通过”。

### 2.2 第一阶段暂不包含

- 真实 AI 大规模正确率；
- 微信开发者工具自动化；
- WXML 真实渲染；
- 真机语音、输入法、权限和弱网；
- 网页测试台；
- 生产数据、真实客户资料或生产写入。

真实 AI 只预留受控 canary，不作为每次开发门禁。Node 通过不等于微信体验版或发布通过。

## 3. 测试原则

1. **同核**：运行器只调用共享核心，不复制业务逻辑。
2. **从原文开始**：主链题不得跳过 parser、route 或 confirmation。
3. **逐层记录**：AI 原始、标准化、合并、确认、保存分别评分。
4. **副作用可见**：不仅看状态字符串，还看客户和业务记录是否实际创建、更新或未变化。
5. **确定性**：fake、clock、ID、初始状态和业务时区固定。
6. **题间隔离**：每题新 MemoryStore，不能依赖执行顺序。
7. **危险优先**：零容忍错误不能被整体平均正确率掩盖。
8. **身份真实**：REAL/MOCK/FAKE/REPLAY 分开统计，replay 不冒充模型成绩。
9. **报告可追溯**：代码、题库、prompt、模型和脏工作区都要记录。
10. **报告与源码分离**：运行产物放忽略目录，不进入 Git。

## 4. 测试题合同

### 4.1 RecordTestCase

| 字段 | 类型 | 必填 | 规则 |
| --- | --- | --- | --- |
| `caseId` | string | 是 | 题库内唯一，发布后不复用旧 ID |
| `title` | string | 是 | 老板看得懂的场景名 |
| `category` | 枚举 | 是 | 见第 8 节 |
| `inputSource` | 枚举 | 是 | `typed` / `voice` / `chat` / `imported` / `test` |
| `originalText` | string | 是 | 严格原文；不能放归一化结果 |
| `businessDate` | `YYYY-MM-DD` | 是 | 相对日期唯一基准 |
| `businessTimezone` | string | 是 | V1 固定 `Asia/Shanghai` |
| `nowInstant` | ISO instant | 是 | 冻结完整时刻，和业务日期一致 |
| `mode` | 枚举 | 是 | `LOCAL_ONLY` / `AI_ONLY` / `PRODUCTION_ROUTING` |
| `reviewMode` | 枚举 | 是 | `standard` / `deep` |
| `context` | 枚举 | 是 | 当前等价复刻用 `home`；目标平台中立值见共享合同 |
| `initialStateFixture` | string 或对象 | 是 | fixture ID；允许小范围显式 override |
| `aiScenario` | 对象 | 条件必填 | fake/mock/replay/real canary 行为；LOCAL_ONLY 为 `none` |
| `steps` | TestStep[] | 是 | 至少含 `RUN_PARSE`；保存题必须含明确请求保存和提交步骤 |
| `expectedRoute` | 对象 | 是 | 同时断言 `productionRoute` 与 `executionPath` |
| `expectedAiCall` | 枚举 | 是 | `MUST_CALL` / `MUST_NOT_CALL` / `MAY_CALL` |
| `expectedAiOutcome` | 枚举/集合 | 是 | 共享核心规范 AI outcome |
| `expectedResult` | 断言对象 | 是 | intent、operation、字段、items、风险和来源 |
| `expectedConfirmation` | 断言对象 | 是 | 展示/编辑/必填/按钮/候选/深度核对 |
| `expectedSavePlan` | 断言对象 | 是 | 正式或待整理计划与写入集合 |
| `expectedStateDiff` | 对象 | 是 | 明确分为 `businessDiff` 与 `fullDiff`，并可列 `mustRemainUnchanged[]` |
| `commitExpectation` | 对象 | 是 | `action: DO_NOT_COMMIT / COMMIT_MEMORY`、`planType: FORMAL / PENDING / NONE`、`expectedCommitStatus` |
| `riskLevel` | 枚举 | 是 | `NORMAL` / `IMPORTANT` / `DANGEROUS` / `ZERO_TOLERANCE` |
| `repeatCount` | 正整数 | 是 | 确定性题默认 1；稳定性/canary 可大于 1 |
| `tags` | string[] | 是 | 业务类型、语言特征、历史、回归号等 |
| `contractVersion` | string | 是 | `record-test-case-v1` |

### 4.2 示例

```json
{
  "contractVersion": "record-test-case-v1",
  "caseId": "local-order-001",
  "title": "简单单商品订单不调用AI",
  "category": "SIMPLE_LOCAL",
  "inputSource": "typed",
  "originalText": "王总礼品盒500套，3块8一套，明天交",
  "businessDate": "2026-07-22",
  "businessTimezone": "Asia/Shanghai",
  "nowInstant": "2026-07-22T02:00:00.000Z",
  "mode": "PRODUCTION_ROUTING",
  "reviewMode": "standard",
  "context": "home",
  "initialStateFixture": "blank-v1",
  "aiScenario": { "kind": "none" },
  "steps": ["RUN_PARSE", "REQUEST_FORMAL_SAVE", "COMMIT_MEMORY"],
  "expectedRoute": { "productionRoute": "LOCAL", "executionPath": "PRODUCTION_LOCAL" },
  "expectedAiCall": "MUST_NOT_CALL",
  "expectedAiOutcome": { "assert": "EXACT", "value": "NOT_REQUESTED" },
  "expectedResult": {
    "intent": { "assert": "EXACT", "value": "order" },
    "fields.quantity": { "assert": "NUMERIC", "value": 500 },
    "fields.unitPrice": { "assert": "NUMERIC", "value": 3.8 },
    "items": { "assert": "ITEMS_MATCH", "count": 1 }
  },
  "expectedConfirmation": { "canSaveFormal": true, "needsDeepReview": false },
  "expectedSavePlan": { "formal": true, "ordersToCreate": 1, "customersToCreate": 1 },
  "expectedStateDiff": {
    "businessDiff": { "customers.added": 1, "orders.added": 1, "pendingNotes.added": 0 },
    "fullDiff": { "orders.added": 1, "orderProgress.added": 1, "aiParseLogs.added": 1 },
    "mustRemainUnchanged": ["quotations", "receivables", "paymentRecords"]
  },
  "commitExpectation": { "action": "COMMIT_MEMORY", "planType": "FORMAL", "expectedCommitStatus": "SUCCEEDED" },
  "riskLevel": "IMPORTANT",
  "repeatCount": 1,
  "tags": ["order", "local", "no-ai", "original-text"]
}
```

示例只说明结构；实际期望仍以当前产品必填和安全规则为准。

### 4.3 expectedAiCall

- `MUST_CALL`：必须恰好按合同调用；零调用或额外调用都失败。
- `MUST_NOT_CALL`：调用次数必须为 0；用于 LOCAL_ONLY、简单 local、pending 未点深度核对。
- `MAY_CALL`：只用于确有允许分支的非门禁探索题，必须记录实际 route；不得用于掩盖尚未决定的产品规则。

`expectedRoute.productionRoute` 使用规范枚举 `LOCAL / PENDING / AI_STANDARD / AI_DEEP`；
`expectedRoute.executionPath` 使用 `LOCAL_ONLY / AI_ONLY_STANDARD / AI_ONLY_DEEP /
PRODUCTION_LOCAL / PRODUCTION_PENDING / PRODUCTION_STANDARD / PRODUCTION_DEEP`。当前遗留小写值只作为 trace 的 rawValue 和兼容输入，不能写进 V1 题库期望。AI 分流指标只统计 `PRODUCTION_ROUTING` 的 productionRoute。

`expectedRoute` 与 `expectedAiCall` 必须同时存在。只断言结果、不写预期路线的题不得进入正式题库。

### 4.4 steps

TestStep 至少支持：`RUN_PARSE`、`REQUEST_DEEP_REVIEW`、`EDIT_FIELD`、
`CHANGE_INTENT`、`SELECT_CUSTOMER`、`SELECT_ORDER`、`SELECT_RECEIVABLE`、
`CONFIRM_FIELD`、`PREPARE_SAVE_PLAN`、`REQUEST_FORMAL_SAVE`、
`REQUEST_PENDING_SAVE`、`COMMIT_MEMORY`。每一步可带输入和对 result revision、
confirmation、savePlan、commitStatus、stateDiff 的断言。

所有正式保存题必须先证明：用户未请求保存时 `commitStatus=NOT_ATTEMPTED` 且 stateDiff 为空；明确请求后才提交。必须有编辑后旧确认/旧 plan 失效、重复点击同一 plan 不重复写的回归题。

## 5. 断言合同

每个期望字段使用显式断言，不能依赖整段 JSON 文本完全相同。

| 断言 | 用途 |
| --- | --- |
| `EXACT` | intent、route、枚举、字符串严格相等 |
| `NUMERIC` | 金额/数量数值相等，忽略 `"500"` 与 `500` 表示差异 |
| `DATE` | 规范业务日期相等 |
| `SET_EQUALS` | 缺失字段、冲突字段等集合相等，忽略顺序 |
| `ONE_OF` | 允许合同明确列出的多个候选之一 |
| `ALIAS` | 客户/单位等允许的受控别名；别名表版本化 |
| `EMPTY` | 必须为空或不存在 |
| `NOT_CONTAINS` | 禁止编造客户、商品、金额、ID 或字段 |
| `CANDIDATES` | 候选集合及是否必须用户选择 |
| `REQUIRES_CONFIRMATION` | 必须阻止正式保存并要求用户确认 |
| `ITEMS_MATCH` | `items[]` 数量、逐项字段、顺序或集合语义 |
| `FIELD_FACT` | value/source/evidence/confidence/userConfirmed 联合断言 |
| `SAVE_PLAN` | 计划中的 create/update/link/precondition 断言 |
| `STATE_DIFF` | 新增、更新、删除及路径值变化 |
| `NO_SIDE_EFFECT` | 指定业务集合完全不变 |

不允许宽泛的 `contains` 把“客户王总”误判成“王老板也行”，除非题目明确声明 `ALIAS`。危险金额、方向、关联 ID 不允许近似匹配。

为保持题目可读，裸字符串、布尔或数字是 `EXACT` 的语法糖；数组和对象不是隐式模糊匹配，必须使用表中的断言或逐路径声明。危险字段建议始终写完整断言对象。

## 6. 时间、时区和 ID

- 所有 V1 业务题固定 `businessTimezone: Asia/Shanghai`。
- `nowInstant` 是绝对事实；`businessDate` 必须等于它按 `Asia/Shanghai` 投影后的日期，否则 case 无效。
- runner 注入 `FrozenClock.nowInstant()` 处理业务时间和 createdAt，另用可控 `monotonicMs()` 处理耗时和截止时间；共享核心不得读取机器本地 `new Date()` 改变答案。
- runner 注入顺序 ID，例如 `customer-case001-001`、`order-case001-001`；不得使用 `Date.now()+Math.random()`。
- 相对日期期望统一写绝对 `YYYY-MM-DD`，同时保留原文证据。
- 必须有跨午夜、月末、年末、闰年和“本周/下周”边界题。
- 中国业务时区无夏令时；服务器或测试机位于其他时区仍不得改变业务日期。

## 7. Fixture 合同

### 7.1 结构

正式 fixture 必须是合成、最小、可读且版本化的 DomainState，并从固定 `empty-domain-v1` 全量底座构造：

```text
{
  fixtureVersion,
  fixtureId,
  description,
  customers,
  quotations,
  orders,
  receivables,
  paymentRecords,
  dunningRecords,
  todos,
  orderProgress,
  pendingNotes,
  aiParseLogs,
  operationLogs,
  productCatalog,
  dunningTemplates,
  deletedRecords,
  meta
}
```

规则：

- 只放本场景需要的记录；
- 使用固定、有人类含义的 ID；
- 名称、手机号、微信聊天和金额必须为合成数据；
- 每题深拷贝，禁止共享可变对象；
- 可以通过小型 `fixtureOverrides` 改日期或金额，但 override 必须写进 case hash；
- 保存前后使用结构化 diff，忽略无业务意义的对象键顺序，不忽略 ID、金额、关联和 originalText。
- 未写出的集合由 `empty-domain-v1` 补固定空数组；禁止调用读取实时 clock/随机 ID 的 `createInitialState()` 作为 fixture 默认值。
- 报告同时输出 `businessDiff` 与 `fullDiff`；后者包含进度、解析日志、操作日志和商品目录，是等价迁移与无意副作用的门禁依据。
- `expectedStateDiff` 中显式列出的路径必须匹配；`mustRemainUnchanged[]` 的路径必须不变；未列出且未禁止的路径表示“不参与本题断言”，但仍受全局零容忍和 schema 不变量约束。

### 7.2 第一版历史 fixture 矩阵

| ID/场景 | 初始最小状态 | 示例输入 | 预期匹配 | 自动正式保存 | 用户确认 |
| --- | --- | --- | --- | --- | --- |
| `blank-v1` 空白 | 无客户、报价、订单、待收、收款、提醒 | “还是上次价格做500个” | 无历史可匹配；价格留空 | 否 | 必须补充或待整理 |
| `single-customer-order-v1` 唯一客户和订单 | 客户 `c-wang`；订单 `o-wang-cup-1` | “王总那单月底交” | 唯一订单 | 仅当前产品安全条件全满足时 | 更新目标与日期需确认 |
| `same-customer-multi-order-v1` 同客户多订单 | `c-wang`；两个未完成订单，商品/日期不同 | “王总那批货月底交” | 候选不唯一 | 否 | 必须选订单 |
| `similar-customer-v1` 重名/相似称呼 | 王总、王老板、王先生三个客户 | “王老板还欠5000” | 只能按确切称呼或列候选 | 未唯一匹配时否 | 必须选客户 |
| `last-quotation-v1` 有上次报价 | 同客户同商品唯一最新报价，价格和日期明确 | “王总礼品盒还是上次价格做500套” | 匹配该报价，来源 `HISTORY` | 依当前订单必填与确认规则 | 历史证据可见 |
| `no-last-quotation-v1` 无上次报价 | 有客户，无同商品报价 | 同上 | 不得编价格 | 否 | 补价格/待整理 |
| `partial-payment-v1` 部分收款 | 待收总额、已收、剩余及一条收款记录一致 | “王总剩下的钱今天付了” | 唯一待收，金额可由剩余派生并标 `DERIVED` | 高风险，按产品确认规则 | 至少确认收款方向和目标 |
| `multi-receivable-v1` 多待收 | 同客户两笔活跃待收 | “王总今天付了3000” | 候选不唯一 | 否 | 必须选待收或明确不关联 |
| `settled-order-v1` 已结清 | 订单与待收均已结清 | “王总这单尾款又收了1000” | 不能继续核销已结清记录 | 否 | 解释冲突/待整理 |
| `quotation-converted-v1` 报价已转单 | 报价含 convertedOrderId，订单已存在 | “把上次报价转订单” | 识别已有转换 | 否，不能重复创建 | 展示已有订单 |
| `multi-item-history-v1` 历史多商品订单 | 单订单含两项商品及逐项规格/金额 | “那单再做一批” | 历史 items 必须全部保留 | 取决于数量/日期是否明确 | 多商品逐项确认 |
| `history-conflict-v1` 历史冲突 | 同客户同商品两份同日报价价格不同，或关联断裂 | “还是上次价格” | 明确冲突，不能静默选 | 否 | 必须选择/补充 |

每个正式 fixture 文件还必须列出初始客户、报价、订单、待收款、收款、提醒的完整最小数组；上表是合同，不是替代数据文件。

## 8. 第一阶段题库分类

### 8.1 `SIMPLE_LOCAL`

至少覆盖简单订单、报价、提醒、待收款、收款和定金。目标是本地正确、生产 route 不做不必要 AI 调用、安全情况下能生成正确 savePlan 和 state diff。

涉及收款或定金的“简单”只表示句式简单，不降低金融安全级别。

### 8.2 `COMPLEX_AI`

至少覆盖多商品、多事项、微信聊天、语音长句、历史引用、指代、收款/欠款/定金混合和字段冲突。必须分别有：

- 当前默认 `pending`、展示深度核对且不自动调用的题；
- 用户选择 `reviewMode: deep` 后必须调用的题；
- standard route 的有效题。

不能提前把所有复杂题的 `expectedAiCall` 写成 MUST_CALL；要服从当前生产规则。

### 8.3 `INSUFFICIENT_INFORMATION`

缺客户、金额、数量、日期或类型不确定。目标：不编造、不危险保存、正确列出缺失/冲突，允许待整理或用户确认。

### 8.4 `AI_FAILURE`

fake adapter 覆盖 401、403、500、网络错误、超时、空响应、非 JSON、空业务 JSON、mock、replay。必须断言请求次数、AI outcome、采用状态、按钮、savePlan 和所有正式业务集合无副作用。

### 8.5 `HISTORY`

逐一覆盖第 7.2 节 12 个 fixture，重点看同客户隔离、唯一性、历史来源、已结清/已转换保护和多商品完整性。

### 8.6 `SAVE_SIDE_EFFECT`

覆盖客户创建/匹配、报价、订单、待收、收款、定金、提醒、待整理、originalText、items[]、重复记录和组合事务回滚。

该类主链题必须设置 `commitExpectation.action=COMMIT_MEMORY`，并断言当前运行时已有的 orderProgress、aiParseLogs、operationLogs、productCatalog 等派生/审计副作用。幂等题需对同一 plan 提交两次，第二次不得新增或重复更新。

## 9. AI 场景与 adapter

### 9.1 Fake 场景

`aiScenario` 至少支持：

- `success_standard`
- `success_deep_multi_item`
- `returned_uncertain`
- `no_record`
- `missing_fields`
- `http_401` / `http_403` / `http_500`
- `network_error`
- `timeout`
- `empty_response`
- `non_json`
- `empty_business_json`
- `metadata_only`
- `mock_provider`
- `replay_response`

每个 fake 返回固定响应、固定延迟、固定 requestId，并记录调用次数和请求体摘要。成功场景必须带一个本地 parser 不会产生的独特字段，以证明未被本地 stub 覆盖。

### 9.2 身份与统计

- `FAKE` 用于确定性门禁，不计模型正确率和费用；可生成 `MEMORY_ONLY` 的成功 savePlan 来检查完整副作用，但不能写真实存储。
- `MOCK` 验证模拟身份和安全阻断，不计真实 AI 成功。
- `REPLAY` 可测标准化/合并/页面和 `MEMORY_ONLY` 保存模拟，不计模型正确率、当轮延迟、稳定性和费用。
- `REAL` 只允许 canary runner，并与所有离线报告分开。

## 10. 主链执行合同

每题按以下步骤执行：

1. 校验 case schema、版本、日期和 fixture。
2. 深拷贝 fixture，生成 `stateBefore`。
3. 创建 FrozenClock、固定 IdGenerator、计数 AI adapter 和 MemoryStore。
4. 用 `originalText` 调用唯一共享核心入口。
5. 校验 AI 请求次数和请求身份。
6. 依次断言 local、productionRoute、executionPath、AI raw、AI normalized、merge、safety。
7. 断言领域 confirmation，不读取页面 `setData`。
8. 断言 savePlan；严格按 `steps` 和 `commitExpectation` 决定不提交或提交 MemoryStore，禁止 runner 自行猜测。
9. 比较 `stateAfter`、`businessDiff` 和 `fullDiff`；检查禁止副作用、幂等和 `commitStatus`。
10. 校验 `originalText`、items[]、字段来源与 trace 完整性。
11. 记录五层分数、failedLayer 和 errorOwner。

如果早期层失败，runner 仍应在安全允许的情况下收集后续诊断；但不得为了拿完整报告而绕过正式保存安全。

## 11. 五层评分

| 层级 | 输入 | 输出 | 责任边界 | 主要错误 | 评分方式 |
| --- | --- | --- | --- | --- | --- |
| 1. AI 原始结果 | AI request + 原文/历史 | `rawModelContent` + `parsedBusinessResult` | 模型、生产 prompt、provider/transport | 意图错、编造、空/非JSON、漏商品、错误历史引用、未安全拒绝 | 仅 REAL 当轮响应计模型分；按危险字段和普通字段分别评分 |
| 2. AI 标准化 | parsedBusinessResult | `aiNormalizedResult` | 解包、业务有效性、字段名、金额、日期、items | 金额转换错、字段丢失、validator接受空业务、日期变坏 | 与 raw 基准和 expected 比；不反算模型错误 |
| 3. 合并结果 | local + normalized AI | `mergeResult` | 合并、冲突、证据和来源 | 正确 AI 被本地覆盖、错误 AI 盲用、items 折叠 | 字段级与冲突级评分，记录 adoption |
| 4. 最终确认态 | merge + final safety + history | `confirmation` | 领域确认逻辑 | 隐藏商品、缺风险、按钮误开、候选错误 | 字段可见/可改/必填/警告/按钮逐项断言 |
| 5. 最终保存 | confirmation + savePlan + state | `businessResult/stateDiff` | savePlan、持久化、原子性 | 错客户、金额方向错、第二商品丢失、半保存 | 记录级和 diff 级精确断言；危险副作用零容忍 |

### 11.1 错误归属规则

- AI raw 正确，标准化后金额错：`AI_NORMALIZER`，不算模型错。
- AI 正确，本地合并覆盖成错误客户：`MERGER`。
- 合并正确，confirmation 隐藏第二件商品：`CONFIRMATION`。
- confirmation 正确，savePlan 丢第二件商品：`SAVE_PLAN`。
- 原文不足，AI 明确拒绝猜测：正确安全结果，不算错误。
- 原文不足，AI 编造金额：高风险 `AI_MODEL` 错误。
- REAL 模型原始内容为空、非 JSON 或只有元数据：第一层 `AI_MODEL` 输出合同错误；若 transport 丢失内容则归 `AI_TRANSPORT`。
- 原始内容有有效业务而解析/标准化后变空：`AI_NORMALIZER`；validator 接受空业务：`AI_VALIDATOR`。
- 401/403/429/5xx 属于 `AI_PROVIDER`，网络中断或超时属于 `AI_TRANSPORT`，不算模型业务错误。
- expected 合同与产品规则不一致：`TEST_CONTRACT`，不能硬改生产代码迎合题目。
- 时区、adapter 或运行依赖错误：`ENVIRONMENT`。

### 11.2 errorOwner 枚举

`INPUT_PROCESSOR`、`LOCAL_PARSER`、`HISTORY_RESOLVER`、`AI_PROVIDER`、
`AI_TRANSPORT`、`AI_MODEL`、`AI_VALIDATOR`、`AI_NORMALIZER`、`ROUTER`、
`MERGER`、`PROVENANCE`、`SAFETY`、`CONFIRMATION`、`SAVE_PLAN`、`PERSISTENCE`、
`TEST_CONTRACT`、`ENVIRONMENT`。

一题可有一个 primary owner 和多个 contributing owners；报告不能把所有失败都记给 AI。

## 12. 字段评分层级

### 12.1 零容忍危险字段

- 客户归属和关联 ID；
- 收款/欠款方向；
- 金额、数量、定金、已收和剩余待收；
- 订单、报价、待收关联；
- 是否允许正式保存；
- 多商品项数和逐项金额；
- originalText。

危险字段按字段和记录双重计数。任一错误进入正式保存即触发零容忍失败，不能被备注等普通字段拉高平均分。

### 12.2 可人工修正普通字段

- 商品简称；
- 备注措辞；
- 非关键规格表达；
- 客户称呼显示格式。

普通字段仍报告准确率，但必须与危险字段分栏。若普通字段变化导致错配客户、金额或商品项数，它立即升级为危险错误。

## 13. 零容忍门禁

下列每项必须为 **0**：

- 危险错误正式保存；
- mock/fake/replay 冒充真实 AI；
- AI 失败、超时、空响应或空业务结果后错误正式保存；
- 收款识别成欠款或欠款识别成收款并保存；
- 错客户自动创建或错误关联；
- 金额、数量、定金、剩余金额错误并保存；
- 多商品保存丢失；
- originalText 丢失或被归一化文本替换；
- 无原文/历史证据的 AI 危险字段被正式采用；
- 应更新旧记录却错误新建正式记录；
- 组合保存失败后留下半笔数据。

任何零容忍失败都使整轮门禁失败，即使其他 99.9% 题通过。

## 14. 确定性硬门禁与质量指标

### 14.1 第一阶段必须 100% 通过

- 三种 mode 的调用隔离；
- local/standard/deep/mock/fake/replay 状态合同；
- AI 失败和空业务结果安全闸门；
- confirmation 与 finalSafety 不矛盾；
- savePlan 结构和前置条件；
- MemoryStore state diff 与事务回滚；
- originalText 保留；
- 多商品结构与保存；
- 固定日期、时区和 ID；
- 所有 `ZERO_TOLERANCE` 题。

这些是安全合同，不按概率放宽。

### 14.2 项目建议门槛

以下数字是货小玲第一阶段的**项目建议**，不是行业标准；先用 V1 题库跑出基线，再由老板和 AI 产品经理确认是否成为硬门禁：

| 指标 | 建议门槛 | 当前阶段处理 |
| --- | --- | --- |
| 简单本地题危险字段正确率 | ≥ 98% | 第一轮先记录基线；零容忍保存错误仍必须为 0 |
| AI 分流正确率 | ≥ 95% | 基线后转硬门槛；未决产品策略题单独统计 |
| 不必要 AI 调用率 | ≤ 10% | 仅对已标 `MUST_NOT_CALL` 的简单题统计；这部分错误当前即失败 |
| 复杂题应调用未调用率 | 总体 ≤ 2%，危险题 0 | 只按当前生产 route 计算，不把 pending 算漏调 |
| 多事项拆分完整率 | ≥ 95% | 确定性已定义题中的危险丢项仍零容忍 |
| 日期正确率 | ≥ 98% | 明确日期的危险错误保存仍零容忍 |

### 14.3 先记录基线、不设硬门槛

- AI 原始正确率（没有真实 AI canary 前不能给）；
- AI 多次运行稳定性；
- 用户手工修正后可保存率（产品规则尚未决定）；
- 真实 AI 平均/p95 响应时间和费用；
- 语音转写后的真实正确率；
- 老板完成确认所需步骤和时间。

真实 AI canary 后再决定模型正确率、稳定性、延迟和成本门槛；微信运行时验证后再决定真实交互门槛。

## 15. 指标定义

- **本地解析正确率**：LOCAL_ONLY 的字段层分数。
- **AI 原始正确率**：REAL AI_ONLY 的 raw 层分数。
- **AI 标准化正确率**：AI_ONLY normalized 层分数。
- **AI 分流正确率**：只统计 PRODUCTION_ROUTING 的 productionRoute/真实调用与 expected 比。
- **最终系统正确率**：第五层通过题 / 可评分题。
- **危险放行率**：危险错误且 `canSaveFormal=true` 或产生正式 state diff 的题 / 危险题。
- **错误阻止率**：本应可正式保存却被阻断 / 应保存题。
- **应调未调率**：`MUST_CALL` 且调用数为 0 / MUST_CALL 题。
- **不必要调用率**：`MUST_NOT_CALL` 且调用数 > 0 / MUST_NOT_CALL 题。
- **正确 AI 被合并改坏率**：raw/normalized 对、merge 错 / AI normalized 正确题。
- **错误 AI 被盲用率**：raw 错且被 ADOPTED、未阻断 / AI raw 错题。
- **失败安全回退率**：AI 异常且无正式危险副作用 / AI 异常题。
- **多商品完整率**：最终逐项正确项数 / 期望项数，并另报整题全对率。
- **多事项完整率**：正确拆分事项数 / 期望事项数。
- **originalText 保留率**：quotation、order、receivable、payment、todo、pending 等 source-bearing 记录中，严格等于输入原文的记录 / 应携带原文的记录。客户、商品目录和纯进度/审计记录不进入分母。

## 16. 测试报告合同

### 16.1 TestRunReport

每次运行必须记录：

- `testRunId`、`startedAt`、`finishedAt`；
- `codeHead`、`worktreeDirty`；
- `coreContractVersion`、`testContractVersion`；
- `caseSetVersion`、`caseSetHash`；
- `mode` 或各 mode 分布；
- `businessDate`、`businessTimezone`；
- `providerKind`、`provider`、`model`、`modelTier`；
- `promptVersion`、`promptHash`；
- `totalCases`、`passed`、`failed`、`dangerousFailures`；
- `aiCalls`、`unnecessaryAiCalls`、`requiredAiMisses`；
- `averageLatency`、`p95Latency`、`estimatedCost`；
- 五层分数、危险字段分数、普通字段分数；
- `environment`：Node/平台版本与 runner 版本；
- `realAiCalled` 与 `productionDataAccessed` 布尔值。

`worktreeDirty=true` 的报告可以调试，但不能作为候选基线门禁证据。

混合报告必须按 `mode + providerKind + provider + model + modelTier + promptVersion + promptHash` 分组输出正确率、延迟和费用；任一字段不同就是独立统计组，不能用一个总平均混在一起。FAKE/MOCK/REPLAY 的 `estimatedCost` 为 `not_applicable`，且不进入真实性能统计。

`caseSetHash` 对规范化后的 case 内容、实际 fixture 内容和 override、别名表、断言规则版本、fake/replay payload、测试合同/schema 版本一起计算。对象键排序、数组语义和数字规范化算法必须版本化，任何一项变化都产生新 hash。

### 16.2 失败题记录

每条失败至少包含：

- `caseId`、`originalText`；
- `expected`、`actual`；
- `failedLayer`、`failedFields`；
- `productionRoute`、`executionPath`、`aiOutcome`、`adoptionStatus`；
- `saveAllowed`、`saveBlockedReasons`；
- `savePlan` 摘要、`commitExpectation`、`commitStatus`、`businessDiff`、`fullDiff`；
- `errorOwner`、`contributingOwners`；
- `traceRef`；
- 是否零容忍、是否阻断整轮。

报告不得包含 API key、Token、Cookie、完整真实手机号或生产客户资料。

### 16.3 产物位置

结构化 JSON、HTML、Markdown、截图和 AI 原始运行结果写入统一被忽略的报告目录；Git 只保存 runner 源码、匿名题库、固定 fixture、手写合同和必要示例配置。

## 17. 真实 AI canary

### 17.1 数据和环境

- 只用完全合成或严格匿名化题目；客户用“王总/李姐”等虚构称呼，手机号使用明显测试号段或不提供。
- 微信聊天去掉头像、微信号、群名、地址、手机号和可识别订单号。
- 金额可保留语义所需数量级，但不能带真实交易组合；商品名仅在无法反推客户时保留，否则泛化。
- 真实失败案例转回归题前，重新写成等价合成场景并人工复核不含身份信息。
- 使用独立测试账号、独立 API key、独立日志空间和只读/无生产存储权限。
- 每请求带 `testRunId`、`caseId`、codeHead、promptVersion；禁止写生产业务数据。

### 17.2 运行规则

- REAL canary 必须使用生产同合同的 adapter、真实生产 prompt 内容和明确 prompt hash。
- standard 与 deep 分开统计；题目按 expected route 选择，不人为提高 deep 成绩。
- 题量、重复次数和每轮费用上限由老板确认；runner 在预计或已用成本达到上限时停止新请求。
- 记录 token、延迟、失败、provider、model、tier、费用估算和每次原始结果。
- 缓存/replay 只能用于 UI、标准化和合并开发；不能计模型正确率、稳定性、真实延迟或当轮费用。
- canary 报告与确定性门禁分开，真实 AI 波动不能掩盖安全门禁失败。

## 18. 现有测试资产迁移原则

| 当前资产 | 可复用内容 | 不能直接当 V1 完整门禁的原因 |
| --- | --- | --- |
| `scripts/record-shared-core-phase1e1-tests.js` | 纯SavePlan、MemoryStore原子Commit、幂等/过期/回滚、双层diff和22个legacy保存等价场景 | 仍以合成Confirmation/result为主；生产business、微信Storage、页面点击和统一五层报告尚未接入 |
| `scripts/record-shared-core-phase1e2a-tests.js` | 单bundleStorage投影、可信adapter/snapshot、零写入Preview、22题完整bundle影子等价、兼容字段和生命周期writer分类 | 使用fake gateway与合成state；真实wx崩溃/配额/写入原子性、持久化revision/CAS、恢复及生产切换尚未验证 |
| `scripts/record-shared-core-phase1e2a1-tests.js` | 单bundle持久化revision/CAS、sealed journal/backup、读回恢复、有界receipt、23 writer门禁、11崩溃点、16故障类、700提交压力及22题事务目标等价 | 仅受保护Fake Gateway/TRANSACTION_PREVIEW；真实wx缺key、配额、崩溃、跨上下文CAS、长期金融幂等和生产切换尚未验证 |
| `scripts/record-shared-core-phase1e2a2-static-tests.js` + 仓库外独立Mini Program | 静态门禁19/19；真实开发者工具独立首次启动、15/15不重载、五类跨Boot恢复/CAS/幂等、容量预检、真实业务key访问0和最终0测试key已验证 | 仅覆盖开发者工具与隔离key；不代表真机断电/配额、真实用户数据迁移、跨进程原子CAS、生产切换或发布通过 |
| `scripts/record-shared-core-phase1e2b1-tests.js` | 可信配置、Shared资格、路径决策、阶段化回退、Recovery Lock、22题Shadow基线、模式转换协议模拟、禁止双写、旧版本门禁和脱敏限量监测 | 仅纯控制面和Fake/Memory/隔离目标；无可信远程开关、版本覆盖率、生产transactional Legacy、真实用户canary或生产Shared写入 |
| `scripts/record-shared-core-phase1d-tests.js` | 统一Confirmation、domain/surface、三mode、多商品、AI状态、revision/hash和页面事实对照 | 尚非WXML运行；用户编辑重算和savePlan未实现 |
| `scripts/record-domain-preflight-tests.js` | 客户/历史/金融/目标/AI/mode统一预检、四方一致性和正式副作用零增量 | 部分关系边界使用合成parseResult；MemoryStore/diff由Phase 1E.1独立runner覆盖，尚未合成统一V1 case runner |
| `scripts/ai-safety-regression-tests.js` | 两个 P0、standard/deep、页面 VM、business 副作用 | 函数级拼装较多，尚无统一 case/trace/stateDiff schema |
| `scripts/parse-route-observability-tests.js` | 四 route、耗时、失败状态和保存阻断 | 依赖 fake wx，未走统一 adapter/confirmation/savePlan |
| `scripts/core-feature-tests.js` | parser、业务、历史、页面函数和查询的大量回归 | 大型脚本、不同层混在一起，失败归属不统一 |
| `scripts/five-step-user-tests.js` | 原文、确认结构、保存和查询链路 | 部分确认通过 VM 提取，尚非共享领域 confirmation |
| `scripts/release-parse-corpus-v2.js` | 大量本地/route 题与失败保护 | 会生成报告；题结构较旧；主要测 local/route，不是五层完整链 |
| `test-fixtures/boss-spoken-v1.json` | 匿名口语输入和字段期望 | 缺 mode、route、初始 state、savePlan/stateDiff 合同 |
| `test-fixtures/real-ai-comparison-v1.json` | 合成 AI 比较题和参考日期 | prompt/模型报告必须与生产绑定；旧成绩不自动代表当前生产 |
| `test-fixtures/release-parse-corpus-v2.js` | 路由和场景生成素材 | 动态依赖机器日期；需 FrozenClock 和规范 case hash |

迁移应写 adapter 将旧 fixture 转成 V1 case，逐步淘汰旧 runner；不得复制 parser 或一次性重写全部题库。

## 19. 第一阶段验收标准

第一阶段完成必须同时满足：

1. 一个 runner 可执行三种 mode，并从原文走到 state diff。
2. LOCAL_ONLY 任何 AI 调用都会失败。
3. AI_ONLY 可独立评分 raw 与 normalized，本地结果不覆盖模型层。
4. PRODUCTION_ROUTING 与当前 local/pending/standard/deep 规则等价。
5. 所有零容忍和确定性硬门禁 100% 通过。
6. 首页和完整页使用的领域 confirmation/savePlan 在核心层只有一份。
7. 每种业务保存副作用和组合回滚都有 MemoryStore 题。
8. SAVE_SIDE_EFFECT 主链题必须 `COMMIT_MEMORY`；同一 plan 重复提交不得产生重复记录。
9. 报告包含代码、题库、mode、provider、prompt、五层结果和 errorOwner。
10. 运行不访问真实 AI、生产数据或微信存储；canary 是独立命令和独立报告。
11. 现有两个已修 P0 的动态回归保持通过。

## 20. 后续四层边界

| 层级 | 目的 | V1 是否实现 |
| --- | --- | --- |
| 第一层：共享核心 Node 自动测试 | 解析、路由、fake AI、合并、安全、confirmation、savePlan、MemoryStore | 本合同范围 |
| 第二层：网页可视化全链路 | 展示同一 trace、批量对比、定位 failedLayer | 后续；只消费核心，不复制逻辑 |
| 第三层：微信开发者工具自动化 | 真实页面输入、按钮、跳转和本地保存 | 后续；验证 WXML/微信运行时 |
| 第四层：真机人工验收 | 录音、权限、网络、输入法、等待感受和老板习惯 | 后续少量人工 |

## 21. 仍需老板决定

1. 复杂输入最终是否自动调用 AI，还是保留用户点深度核对。
2. 深度核对是长期入口还是过渡措施。
3. AI 失败后用户明确修正全部危险字段，是否允许正式保存。
4. 哪些危险字段必须额外明确确认。
5. 第一阶段真实 AI canary 的题量、重复次数和每轮成本上限。

上述未决项必须通过 case 标签或策略版本隔离；未决定前，确定性门禁以当前产品事实为准，不能让题库偷偷改变产品。

## 22. E2E Case Contract V1 与核心题库

Phase 1 已将测试输入统一到 `tests/record-e2e/`。详细机器合同见
`docs/RECORD_E2E_CASE_CONTRACT_V1.md`。

核心规则：

1. 120 条 ACTIVE 题使用统一 caseId、固定 clock、匿名 initialState、AI profile、交互、Result、Route、Preflight、Confirmation、Surface、Save、State Diff、重启/幂等和风险合同。
2. 所有 expected 来自产品合同、安全规则、业务 State 合同和人工审查；不得从当前代码运行结果生成。
3. `HEADLESS_DETERMINISTIC` 使用 Local/Fake/Replay 和隔离 Memory；`REAL_QWEN_QUALITY` 是独立候选标签，不表示已运行真实千问。
4. Case V1.1 将生产观察与测试执行拆开：Fake/Replay生产资格必须阻断非真实Provider，但业务安全允许时可由`TEST_ONLY_ISOLATED_LEGACY_COMMIT`验证Legacy State Diff。
5. 产品语义未决项进入独立 backlog，不计入 ACTIVE 核心题。
6. `scripts/validate-record-e2e-corpus.js` 是结构、语义、隐私、去重和覆盖的离线门禁；不生成报告文件。
7. `expected.result` 判定 normalizer 与人工交互后的 Confirmation 标准语义层；原始 parser 别名和 Storage 字段分别由 adapter 与 State Diff 映射，不能在同一 operation 中混写。
8. 冲突候选使用 `conflictValues`，不会像 `allowedValues` 一样放宽判分；复杂交互、字段断言和关系断言均使用封闭机器结构。
9. PAGE与HEADLESS生产观察是不同lane；HEADLESS不能冒充页面。页面缺少Case要求的真实能力时归类`CASE_FAIL/SURFACE_ERROR`，Runner不会伪造事件。
10. `PERSIST-003`是事务材料exact replay：页面只生成确认草稿，首次事务由
    `TEST_ONLY_ISOLATED_LEGACY_COMMIT`执行，页面正式保存handler实际调用为0；事务层
    原样重放返回`ALREADY_COMMITTED`，它不是第二次页面点击。
11. HEADLESS题需要隔离提交时必须额外通过真实完整页生成确认草稿；`FIN-014`的同一点击风暴由页面防重lane抑制第二次进入事务，不使用`ALREADY_COMMITTED`替代UI证据。

Phase 2A 只修订执行边界合同。Phase 2B.1 已新增
`scripts/run-record-e2e-headless.js` 与 `tests/record-e2e/runner/` 执行内核：父进程保留
Expected并负责断言，每题由独立Node子进程在Fake wx/network/voice、固定clock和隔离
Storage中加载真实页面JS、生产parser、Legacy business与Release A Coordinator。详细边界
见 `docs/RECORD_E2E_RUNNER_KERNEL_V1.md`。

Phase 2B.1 首次复查因未执行 Lane、空 State Restart 和缺少事务/隔离硬证据而停止；这些
旧结果不得引用。R2要求每个 Lane 具有计划、前置、启动、核心动作、完成证据、断言和清理
状态，缺一项即 `RUNNER_ERROR/LANE_EXECUTION_EVIDENCE_MISSING`。`--plan-only`还必须检查
需要首次成功提交的Case是否具备安全Expected、非零业务Diff和订单固定交期；它不是第二套
生产Preflight，运行时仍执行真实Domain Preflight。

R2按既有“正式订单必须有客户、商品和交期”合同，为`PERSIST-001/002/003/004`补充固定
合成交期；`PERSIST-004`并发B的“200个/4元一套”显式单位冲突机械统一为
“200个/4元一个”；同时机械修正`BASIC-020`专属pending fixture原文。上述是
`TEST_DATA_ERROR_FIXED`，没有放宽产品规则或改变题目业务目标、Lane或最终业务Expected。
Plan-only会拒绝首次成功提交合同不成立、并发B缺交期或显式单位冲突、pending目标/原文
不一致及required selection目标不存在。

Phase 2B.1-R2 仍只运行24题代表性Smoke和120题plan-only，不代表120题已全量执行，不是
WXML页面E2E，也不是真实千问测试。24题双轮结果为`PASS=0 / CASE_FAIL=24 /
RUNNER_ERROR=0 / BLOCKED=0`且确定性一致；`CASE_FAIL`保留产品实际差异。`expected.save`
仍只表示业务正确语义；生产资格、隔离目标和TEST_ONLY标记分别由
`productionObservation`、`isolatedExecution`承担。

## 23. E2E Phase 2B.2-R1 全量基线

Phase 2B.2首次第1轮因Runner把`HOME_QUICK + SAVE_PENDING`错误固定调用为完整页
`savePending()`而作废，产品统计不得引用。R1建立不含Case ID特判的Surface/editMode/
action注册表：HOME待整理使用`savePendingFromConfirm`，FULL待整理使用`savePending`；
映射缺失不fallback，实际方法名与解析结果不一致时即为Runner错误。

修复后从清洁Worker环境完整执行120题两轮，结果均为`PASS=4 / CASE_FAIL=116 /
RUNNER_ERROR=0 / BLOCKED=0`。每轮网络、未知Fake路由、真实wx Storage、宿主文件Storage、
fixture mutation、跨Case泄漏、Journal和Backup均为0；65条P0失败全部单题重跑，P1按
stage/Ownership/category分层抽查10条，结果一致。Runner Kernel自测为41/41，其中专门
证明Restart子Worker发生错误时仍会通过finally返回完整隔离审计。

`failureStage`描述最早差异层，`failureOwnership`描述当前证据责任归属，两者不得混用。
原始R1基线只有`PAGE-008`被高置信确认页面Confirmation不同步，五条订单/报价选择题被
确认页面能力缺口；当时105条证据不足的差异保持`UNCLASSIFIED_REQUIRES_REVIEW`，
并形成39个Cluster。后续能力修复不得改写这份历史证据；当前数字见
`docs/RECORD_E2E_FULL_CORPUS_BASELINE_V1.md`。

## 24. 完整页通用订单选择合同

`SELECT_ORDER` Cluster Fix只补齐完整输入页的通用订单选择，不改变parser、AI、Domain
Preflight政策或Legacy保存语义。

订单候选必须来自Domain Preflight已经允许的候选ID，再由页面使用当前State生成安全展示
投影。页面不得自行猜测历史订单、自动选择第一项、接受任意事件ID或跨客户关联。真实页面
方法必须支持选择、取消和改选，并将稳定`orderId`写入当前确认草稿；每次交互及保存前都要
基于最新State重建Confirmation和Preflight。

`BASIC-010`、`REL-003`、`REL-009`不再因缺少`SELECT_ORDER`能力失败；当前分别进入
`LOCAL_PARSE_ERROR`、`AI_NORMALIZE_ERROR`和`AI_NORMALIZE_ERROR`。这些上游差异、
`SELECT_QUOTATION`和`PAGE-008`不属于本次修复范围，Expected保持不变。订单选择专项
测试15/15，全量120题两轮仍为`PASS=4 / CASE_FAIL=116 / RUNNER_ERROR=0 /
BLOCKED=0`且确定性一致。

## 25. 安全报价候选与危险引用合同

Domain Preflight是报价候选唯一真值源。安全候选必须来自最新State，并按当前客户、
operation、活动状态、删除事实和转单关系筛选；页面和AI fixture不得建立候选身份。
Shared Confirmation只投影该结果，不复制安全规则，也不根据候选数量自动选择或强迫选择。

`REL-007`和`REL-008`不是合法报价picker题，已改由
`RELATION_REFERENCE_TAMPER_GUARD`明确注入跨客户或已转报价ID，再执行真实Preflight。
两题继续保持P0、原阻断码和零副作用Expected，不调用页面选择或business保存。

本阶段报价候选专项22/22、合同自测24/24、Runner Kernel自测48/48。危险关系Lane的
页面方法、business、Storage和事务零调用结论来自动态前后计数及Storage Diff，不使用
硬编码`false`；出现非零活动或审计仪表缺失时必须归为`RUNNER_ERROR`。120题双轮仍为
`PASS=4 / CASE_FAIL=116 / RUNNER_ERROR=0 / BLOCKED=0`且确定性一致；两条危险关系Lane
均PASS，Case整体仍因上游AI标准化/确认语义差异失败。详情见
`docs/RECORD_QUOTATION_CANDIDATE_SOURCE_V1.md`。
