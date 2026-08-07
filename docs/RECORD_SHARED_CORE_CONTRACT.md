# 记一笔共享核心合同（候选 V1）

> 状态：**合同已定稿；Release A RC1 已把生产 Legacy writer 接入事务 Coordinator
> 并通过候选回归；production 固定 `LEGACY_ONLY`，共享生产 Commit 仍禁用；候选尚未
> 上传或发布，没有真实用户 canary、可信远程 kill switch、客户端覆盖率、真机或真实
> AI 验证。**
>
> 本合同最初以 `fix/p0-ai-result-integrity` 分支、`c1818817353b91d4d9cd53eb47bc4a01c8c046d0`
> 的真实代码定稿；Phase 1B 从 Phase 1A 提交 `5109f04982332e0f5f6be649926f6595f6d81489` 开始实现。实现状态以本节记录和对应候选提交为准，不得借合同之名改变当前 AI 分流产品规则。

## 1. 权威范围

本文件是“记一笔共享核心”的权威接口合同，回答共享核心接收什么、按什么顺序处理、输出什么，以及微信小程序、网页测试台、Node 测试怎样共用一套业务逻辑。

本文件不取代：

- `AGENTS.md` 的产品最高规则；
- `docs/RECORD_CONFIRM_CARD_SPEC.md` 的用户字段和文案规范；
- `docs/RECORD_TEST_CONTRACT_V1.md` 的测试题、评分和门禁合同；
- 当前生产代码。合同落地前，当前代码仍是运行事实。

### 1.1 Phase 1A 当前实现状态（2026-07-22）

Phase 1A 已新增：

- `utils/record-flow-contract.js`：统一 mode、route、执行路径、AI 请求/结果/采用、providerKind、安全、阶段和错误码；旧值通过 normalizer 映射，未知值不降级成安全值。
- `utils/record-flow-trace.js`：每次运行独立、可 JSON 序列化的内存 trace；严格原文与 normalizedText 分槽，凭证型字段和错误文字做基础脱敏。
- `utils/record-flow-core.js`：平台无关的 `runRecordFlow(input, dependencies)` 门面；从原文调用现有 parser、安全、route、AI 有效性/合并和最终保存闸门，只返回解析结果、trace、确认摘要和保存资格，不写存储。
- `utils/record-flow-ai-adapters.js`：现有微信 AI 请求的兼容 adapter；fake/mock/replay/no-AI 由核心固定工厂提供，通用调用方不能把任意函数注册成 `REAL`。
- `scripts/record-shared-core-phase1a-tests.js`：从原文执行真实 parser/route 的离线特征测试，并用 Phase 1A 起始 HEAD 的冻结金样本检查关键结果等价。

Phase 1A 当时只正式支持 `PRODUCTION_ROUTING`；`LOCAL_ONLY` 和 `AI_ONLY` 只定义枚举并明确拒绝，不会偷换成生产模式。该限制已由 Phase 1C 按本合同解除。页面尚未切换到新门面；`savePlan`、MemoryStore、state diff、完整 confirmation 和字段来源仍未实现。

Phase 1A trace 被标记为 `MEMORY_ONLY`，包含业务原文和解析内容；在完整 `TraceOptions.redaction` 落地前不得直接持久化。当前兼容 normalizer 仍把“AI 标准化+合并”作为一个遗留步骤，所以 `ai.rawResult` 已可记录，而 `ai.normalizedResult=null`、`normalizationAvailable=false`，不能据此宣称第二层评分已实现。

新门面在自身 output/trace 中逐字保留 `originalText`；现有正式保存入口仍读取遗留 `original_text`。因此 Phase 1A 只证明门面原文保护，尚未证明未来页面切换后的最终持久化合同。

### 1.2 Phase 1B 当前实现状态（2026-07-22）

对应代码与测试提交：`3688cef1463b021fb091272a3a5f52f52c0c6c95`。

Phase 1B 在不迁移页面和保存逻辑的前提下新增并验证：

- `utils/record-flow-runtime.js` 提供 `clock.now() → Date`、默认 `systemClock`、`Asia/Shanghai` 业务日期投影，以及可注入的 `idGenerator.next(scope)`；服务端部署目录保留逐字同步的 `server/utils/record-flow-runtime.js`。
- `runRecordFlow()` 每次运行只确定一次 `businessTimezone`、`businessDate` 和业务 `nowInstant`，并把同一上下文传给本地 parser、安全检查、AI adapter、AI 日期标准化和最终安全检查。
- 当前 Phase 1B 只正式支持 `Asia/Shanghai`（明确的 UTC+08:00 业务合同）；其他时区返回 `UNSUPPORTED_BUSINESS_TIMEZONE`，不静默使用运行机器时区。
- 输入只给 `nowInstant` 时按上海时区推导 `businessDate`；二者都给时必须一致，否则返回 `BUSINESS_DATE_MISMATCH`；都不提供时从同一次 `clock.now()` 取值。为兼容现有固定日期 fixture，只给 `businessDate` 时允许 `nowInstant=null`，并在 trace 标记 `nowInstantResolved=false`；完整 V1 runner 仍应同时提供二者。
- 现有 `parseHybridInput()` 也会在入口固定一次兼容时间上下文，因此尚未迁移的两页不传新字段时仍可运行，且同一次 local、standard/deep 请求和 AI 合并使用同一上海业务日期。
- trace 新增 `runtime`、`traceId` 和 AI `requestId`；`runId`、`traceId`、AI `requestId` 可由测试固定。服务端自身生成的编号另记为 `serverRequestId`，不得冒充上游模型的 `providerRequestId`。
- standard/deep 服务端 prompt 统一使用经校验的业务日期；旧客户端省略日期时由服务端上海 clock 补齐，不再用 UTC `toISOString().slice(0, 10)`。
- 1,490 题 fixture 和正式 runner 已固定并接线传递业务日期与时区；专项测试验证了题数、fixture 字段和 runner 接线，但本轮没有生成报告或全量重跑 1,490 题。其他专项覆盖系统时区差异、上海午夜、跨年、下周五、月底、非法输入、倒退 clock、固定/重复 ID、旧调用兼容和 server 独立部署加载。

本阶段没有完成整个合同中的时间/ID改造：`clock.monotonicMs()`、deadline、parser 自身的兼容 `parse_*` ID/`createdAt`、正式业务记录 ID、保存时间和存储 ID 均未迁移；现有 provider 响应 ID 也尚未进入 trace。页面未切换到 `runRecordFlow()`，保存逻辑未修改，真实 AI 与微信运行时仍未验证。

### 1.3 Phase 1C 当前实现状态（2026-07-22）

对应代码与测试提交：`c5821efe5ac4af4a1414f102928472a11f5186ad`。

Phase 1C 在不迁移页面和保存逻辑、不改变生产 route 的前提下新增并验证：

- `runRecordFlow()` 已正式启用 `LOCAL_ONLY`、`AI_ONLY`、`PRODUCTION_ROUTING`；未传 mode 兼容默认生产模式，显式非法 mode fail closed。
- `LOCAL_ONLY` 仍运行真实 parser、安全和生产 route，但执行路径固定为 `LOCAL_ONLY`，任何 productionRoute 下 AI adapter 调用数均为 0；其保存资格只代表本模式评估，不能冒充完整生产结果。
- `AI_ONLY` 的本地解析是只写 trace 的影子阶段；standard/deep 只由显式 `reviewMode` 决定。adapter 请求中的 `localDraft` 和 `productionRoute` 均为空，本地客户、商品、数量、金额、缺失项和 route 不得进入 AI_ONLY 最终结果或确认摘要；影子本地失败也不会阻止 AI 执行。
- AI_ONLY 复用 `utils/ai-parser.js` 的同一业务有效性与标准化规则，但不调用本地+AI 合并；trace 明确 `local.shadowOnly=true`、`merge.performed=false`，并保留 raw、parsed 和 normalized AI 层。
- adapter 统一提供受信身份、能力和 `parse(request, hooks)`。REAL 身份继续由私有注册机制保护；FAKE、MOCK、REPLAY、NONE 不能被模型返回 JSON 伪造成 REAL，transport 事件也不能由业务结果伪造。
- REPLAY 仅用于合成固定结果，真实延迟、成本和真实 AI 调用统计均标记不适用；MOCK/FAKE/REPLAY 不具有真实存储提交资格。
- 输出和 trace 增加 `resultScope`、每次运行的 adapter 调用事实、模式/生产保存资格及其可解析状态。由于生产合并尚无逐字段来源证据，成功调用不猜测为完整采用，`adoptionStatusResolved=false`。
- `scripts/record-shared-core-phase1c-tests.js` 的 16 组专项测试全部通过；Phase 1A 25/25、Phase 1B 24/24、两个 P0、route、五步用户、核心功能、模型路由和服务端 standard/deep mock 回归同时通过。

Phase 1C 仍不是完整 V1：页面尚未调用共享入口，统一 confirmation、字段来源、savePlan、MemoryStore、state diff、promptVersion/hash 和完整报告均未实现；本轮没有调用真实 AI、生产 endpoint 或生产数据，也没有验证微信运行时。

### 1.4 Phase 1D 当前实现状态（2026-07-22）

Phase 1D 在不迁移页面主解析流程、不改变 AI route 和不实现 savePlan 的前提下完成：

- `utils/record-confirmation-contract.js` 与 `utils/record-confirmation-builder.js` 提供平台无关、可 JSON 序列化的 Confirmation；领域保存资格与 FULL_PAGE/HOME_QUICK/HEADLESS_TEST 的界面能力分开表达，兼容 `confirmationSummary` 只从完整 Confirmation 派生。
- `utils/record-domain-preflight.js` 成为保存前领域安全的唯一权威纯规则，统一客户、报价、订单、待收、收款、定金、金额、更新目标、候选选择、AI 完整性和非生产 mode 的正式保存限制，并生成稳定 `preflightFingerprint`。
- operation 只能携带保存层会消费的关系 ID；近似客户称呼需明确选择，跨客户/失效待收催款、订单与待收选择冲突、未知收款类型、待收汇总与付款明细冲突、订单结算历史无法对账均 fail closed。收款记录的 kind 由 operation 与实际关联派生，不相信输入中的任意字符串。
- `runRecordFlow()`、Confirmation、完整页、首页与根目录 `business.saveConfirmedDraft()` 共同消费同一预检；首页只额外施加 surface 能力限制。页面 WXML/WXSS、解析/AI 主流程和保存数据结构均未迁移。
- AI 参与采用 fail-closed：只有明确完成、业务有效且身份可信的 REAL 结果才可能取得生产资格；共享结果携带由受信 adapter 注册表生成的 mode/resultScope/provider 身份，模型 JSON 不能把 FAKE/MOCK/REPLAY 提升为 REAL。LOCAL_ONLY、AI_ONLY 和非真实 provider 的结果交给 business 仍会在写入前被阻断。
- AI JSON 中伪造的 `parse_route`、`record_flow_context`、本地/最终安全和 trace 控制字段在标准化层被丢弃，不能把 mock 或失败结果伪装成 REAL/USED/local 路径。
- 阻断发生在任何客户或正式业务记录变更之前；专项测试同时断言客户、报价、订单、待收、收款和提醒的正式增量为 0，并验证允许的多商品订单、部分/结清收款、严格原文保存。
- Confirmation 的 revision/contentHash 已实现；用户编辑后的完整重算、字段来源/evidence 完整体系仍未实现。

专项动态结果：`record-shared-core-phase1d-tests.js` 16/16、`record-domain-preflight-tests.js` 20/20；Phase 1A/1B/1C、AI P0、route、五步用户、核心功能、金融生命周期、模型路由和服务端 mock 回归同时通过。根目录与 server business 镜像均验证正常报价转订单的双向关系。全程清除 AI 环境变量，没有调用真实 AI、外网或生产数据。

服务端当前没有正式业务保存路由；`server/utils/business.js` 仅为离线镜像。仓库完整运行时复用根目录权威预检，若只部署 `server/` 而缺少该共享模块则镜像保存入口 fail closed，不会降级到另一套保存规则。后续若服务端正式承接保存，部署包必须显式包含共享核心，而不是复制规则。

### 1.5 Phase 1E.1 当前实现状态（2026-07-22）

Phase 1E.1 在不迁移页面、不切换生产 `saveConfirmedDraft()` / `savePendingNote()`、不接入微信 Storage 的前提下完成：

- `utils/record-save-plan-builder.js` 从已绑定 Confirmation、统一 Preflight 和只读 state snapshot 生成纯数据计划；正式保存和明确待整理严格分开，阻断计划的 operations 恒为空。
- `utils/record-save-commit.js` 校验 plan/hash、用户授权、Confirmation/Preflight/state 绑定、operation schema、临时关系和依赖图，再在 MemoryStore 工作副本上提交；任一步失败完整回滚。
- `utils/record-memory-store.js` 深拷贝初始 state，提供版本、指纹、事务、失败注入和成功 receipt 索引；同一计划重放返回 `ALREADY_COMMITTED`，planId 或幂等键碰撞 fail closed。
- `utils/record-state-diff.js` 同时输出老板可见的 `businessDiff` 和包含日志、目录、进度、meta、模板及兼容顶层状态的 `fullDiff`；created/updated/deleted、changedFields 与集合顺序均稳定。
- SavePlan 的 ID 关系使用受限临时引用并显式声明依赖；普通原文、商品和备注中的 `temp:` 不会被解释为基础设施 ID。Commit 最终不变量禁止新增跨客户金融关系、收款/待收增量不一致和超额定金，但不会因无关历史脏记录而错误阻断当前新业务。
- `runRecordFlow()` 仅在调用方显式设置 `prepareSavePlan=true` 时返回计划，默认仍为 `savePlan=null`，且永不自动 commit。
- `scripts/record-shared-core-phase1e1-tests.js` 20/20 通过：包含22个记一笔 legacy `saveConfirmedDraft` / `savePendingNote` 等价场景、6类失败注入、幂等/碰撞/过期计划、LINK合同、金融关系、授权/schema fail-closed、多商品、严格原文、目录回填、日志截断和 diff 审计。Phase 1A～1D、领域预检、P0、路由、五步用户、核心/金融生命周期和服务端 fake 回归同时通过。

“记一笔关联报价创建订单”已按当前 `saveConfirmedDraft(create_order + quotationId)` 对照；报价页直接 `convertQuotationToOrder()` 与订单页直接 `generateReceivableFromOrder()` 是独立页面生命周期入口，本轮只做边界回归，未伪装成 Confirmation SavePlan，也未迁移。Phase 1E.2 才负责让生产记一笔 business 入口消费共享计划与 Commit；直接页面生命周期若未来纳入计划，必须另有明确 action 合同。

### 1.6 Phase 1E.2A 当前实现状态（2026-07-22）

Phase 1E.2A 只建立存储边界和影子证据，不切换生产写入：

- 当前业务数据由 `utils/storage.js` 以单一 bundle key `yiwu_boss_ai_assistant_v1` 整体读取/替换；身份 key `huoxiaoling_ai_auth_session_v1` 以及 `pending_to_edit`、`record_to_edit`、`force_text_input`、`draft_to_input`、`finance_segment` 五个页面交接/偏好 key 不属于 DomainState，适配器不得读入或覆盖其内容。
- bundle 内已分类 `meta`、客户、报价、订单、待收、收款、提醒、待整理、订单进度、AI/操作日志、产品目录、催款记录/模板和删除记录；不存在单独持久化的 `records` 索引。`productCatalog` 同时含自动学习和人工维护内容，不得视为可随时重建的纯缓存；未知顶层和记录字段在投影/反投影中保留。
- `utils/record-storage-state-projector.js` 把旧 key-value 快照投影为完整 DomainState，并生成覆盖全部业务、日志、目录、进度和兼容字段的 fingerprint；反投影只提出一个业务 bundle 写入，不物化原本不存在且未变化的可选空集合。
- `utils/record-storage-adapters.js` 提供受保护 gateway/adapter 身份、只读 snapshot 和 `previewCommit()`。Preview 在 MemoryStore 工作区执行共享 Commit，返回 diff 与 proposedWrites，但对 gateway 的写入/删除恒为 0；外部普通对象不能注册成 WX gateway，调用方伪造、跨 adapter 或已过期 snapshot 会被拒绝。
- 当前原子性只能描述为 `SINGLE_BUNDLE_REPLACE_UNVERIFIED`：应用代码确实只调用一次 `wx.setStorageSync` 替换整包，但仓库无法证明崩溃、配额、序列化或设备异常时的持久化原子性。现有 Storage 也没有持久化 revision/CAS、写后读回、journal、恢复协议或幂等 receipt；`app.js` 启动时还会读后立即整包写回。因此真实共享 Commit 继续返回 `SHARED_PRODUCTION_COMMIT_DISABLED`。
- `scripts/record-shared-core-phase1e2a-tests.js` 13/13 通过：22 个 Phase 1E.1 代表场景分别经 legacy fake-wx 保存/重载和共享 Storage 投影/Preview/反投影，完整业务 bundle 等价；未知兼容字段、可信身份、snapshot 新鲜度、fullDiff 和零写入同时受检。23 个生产整包写入调用已按文件、调用种类和文件内序号逐点绑定到生命周期；6 个非业务 key 同时登记并静态核对生产者/消费者。

当前真实 Storage 拓扑：

| key / 状态 | 类别 | 当前写入边界 | 是否进入 DomainState |
| --- | --- | --- | --- |
| `yiwu_boss_ai_assistant_v1` | 业务总状态 | `saveState()` 单次整包替换 | 是，唯一业务 key |
| `huoxiaoling_ai_auth_session_v1` | 登录/鉴权 | `utils/api-client.js` 独立写入 | 否 |
| `pending_to_edit` / `record_to_edit` | 页面跳转交接 | 页面独立写入 | 否 |
| `force_text_input` / `draft_to_input` / `finance_segment` | 页面偏好/草稿交接 | 页面独立写入 | 否 |

页面仍直接调用 legacy business；`saveConfirmedDraft()` / `savePendingNote()` 未接入共享 Commit，WXML/WXSS 未修改。报价转单、订单生成待收、直接收款/催款、订单状态/交期、提醒完成、待整理处理、软删除/撤销、客户合并/复核、目录维护、onboarding 和 app 启动已分类，但除代表性边界外未宣称 SavePlan 等价或完成迁移。Phase 1E.2B 只有在持久化 revision/CAS、写后读回、恢复/回退协议以及所有旧 writer 协调方案明确后才可切换。

### 1.7 Phase 1E.2A.1 当前实现状态（2026-07-23）

Phase 1E.2A.1 在不迁移页面、不切换 production business、不访问真实微信 Storage 的前提下完成事务协议和 writer 协调的离线实现：

- `utils/record-storage-coordinator.js` 成为业务 bundle 的根协调门面；23 个已登记 app/page writer 均继续沿用原调用方式并最终进入根 `utils/storage.js`，`server/utils/storage.js` 动态委托同一根门面，`app.js` 初始化也使用明确的初始化入口。生产模式硬编码为 `LEGACY_ONLY`，正常无竞争写出的旧 bundle 内容不变；每次 legacy 写入前重新读取并比较受签名 read context，过期 writer 返回 `LEGACY_WRITER_STALE`，不覆盖更新后的 bundle。
- 事务控制信息使用保留顶层槽 `__hxlRecordStorageV1`，不进入 DomainState、业务 diff 或登录/页面 key。旧 bundle 无该槽时按 revision 0 读取；只有成功的事务预演提交才生成单调 revision。控制信息包含 schema/revision、最后 transaction/plan/hash、业务 fingerprint、提交时间和有界 receipt 账本；未知旧 `meta` 与业务记录字段保持原样。
- `utils/record-storage-transaction.js` 实现受保护 Fake Gateway 上的单 bundle 协议：严格序列化与峰值容量预检 → sealed backup → sealed `PREPARED` journal → CAS → `MAIN_WRITE_STARTED` → 最终 CAS → 主 bundle 写入 → 立即读回校验 revision/transaction/plan/业务与整包 fingerprint/receipt → 先 journal、后 backup 清理。仅 `setStorageSync` 未抛错不算成功。
- CAS 同时绑定 `baseRevision + baseFingerprint`。在最终主写前发现外部变化会清理本事务材料并返回 `STALE_STORAGE_SNAPSHOT`；重启恢复遇到合法但既非旧态也非目标态的 bundle 会保留现状和恢复材料并返回 `STORAGE_RECOVERY_REQUIRED`，不会猜测或用 backup 覆盖可能较新的数据。
- 恢复状态机能区分“仅准备且主 bundle 仍旧”“目标 bundle 已写但未清理”“主 bundle 结构损坏且 backup 可验证”“三方矛盾”。前两者分别回滚清理或补齐提交，结构损坏时只在 sealed 材料严格匹配后恢复旧态；矛盾或无法验证时阻断后续写入并保留材料。恢复函数可重复调用，不重复执行业务操作。
- 持久化 receipt 绑定 planId、planHash、idempotencyKey、transactionId、revision 和目标业务 fingerprint；保留最近 128 条完整 receipt、最多 512 条 tombstone，并优先保留最近 64 条高风险金融 receipt。同计划在保留窗口内跨 adapter 重建返回 `ALREADY_COMMITTED`，相同 planId 不同内容返回 `SAVE_PLAN_ID_COLLISION`。这是有界本地防重，不代表被淘汰后的无限期金融幂等。
- gateway 与 adapter 身份来自私有注册表且对象被冻结；普通对象、返回 JSON 或方法覆盖不能提升为可信 WX/REAL 写入身份。事务管理器本轮只接受显式 Fake Gateway 的 `TRANSACTION_PREVIEW`；真实 WX adapter、生产 `SHARED_COMMIT` 和 app 启动自动恢复均保持禁用。
- `scripts/record-shared-core-phase1e2a1-tests.js` 为 22/22：静态核对 23 个 writer 与无旁路、旧 bundle 兼容、legacy stale CAS、队列与并发重复点击、11 个崩溃检查点、16 类读写/损坏/清理故障、容量未知/不足、700 次 receipt 淘汰压力、重启恢复、22 个业务场景的 legacy/shared/事务目标三方语义等价。测试只使用合成 state 和 Fake Gateway。

本实现的威胁边界是“同一受控 JavaScript 协调器内的并发、非恶意异常和存储损坏检测”。当前 hash 不是密码学认证；微信 Storage 缺 key、配额、崩溃持久化和 copy-on-write 余量尚未实测，读-校验-写也不是跨进程/跨上下文的存储层原子 CAS。真实启用前还必须在微信开发者工具的隔离环境验证这些行为，并确认所有 writer 同属排他协调边界。Phase 1E.2A.1 候选不能作为生产切换或发布依据。

### 1.8 Phase 1E.2A.2-R1 当前实现状态（2026-07-23）

Phase 1E.2A.2-R1 已在微信开发者工具的独立 Mini Program 中完成隔离 Storage 运行时验证：

- 开发者工具直接打开仓库外物化的独立测试目录；测试 `app.js` 在加载事务模块前先安装四 key 硬白名单，不加载生产 `app.js`、onboarding、`initializeState()` 或普通业务页面。生产项目配置反向忽略测试入口与运行时专用源码，正式 `app.json` 不注册测试页。
- 首次启动、15 项不重载测试、5 次真实“重新进入小程序”和最终清理形成 6 个独立 Boot。append-only 审计显示整个运行中 `yiwu_boss_ai_assistant_v1` 读取、写入和删除次数均为 0，白名单外访问次数为 0。
- 真实 wx Storage 测试 key 上，15/15 不重载用例通过，包含基础写后读回、旧 bundle 迁移、revision/CAS、stale writer、planId 碰撞、容量预检、真实 coordinator 队列和四类读回异常。
- 五类跨 Boot 验证分别得到：仅 `PREPARED` 时 `RECOVERED_ROLLED_BACK`；主 bundle 已写时 `RECOVERED_COMMITTED`；主 bundle 损坏且 backup 有效时 `RECOVERED_ROLLED_BACK`；三方矛盾时 `RECOVERY_REQUIRED` 且材料保留；同 plan 跨 Boot 时 `ALREADY_COMMITTED`，相同 planId 不同 planHash 继续返回 `SAVE_PLAN_ID_COLLISION`。
- 容量信息由真实 `wx.getStorageInfoSync()`读取；容量不足使用 gateway 测试限额在主 bundle 写入前阻断，没有填满开发者工具 Storage。最终四个隔离测试 key 全部删除，页面冻结证据为 revision 0、receipt 0、test key count 0。
- 真实页面和 production business 未迁移，生产模式仍为 `LEGACY_ONLY`，`SHARED_COMMIT` 仍在 adapter/coordinator 两层禁用。本阶段未验证真机断电、真实设备配额/落盘细节、真实用户数据迁移、跨进程存储层原子 CAS 或长期 receipt 淘汰后的金融幂等，不构成生产切换或发布结论。

### 1.9 Phase 1E.2B.1 当前实现状态（2026-07-23）

Phase 1E.2B.1 只实现共享保存受控切换控制面和隔离演练，没有迁移页面或 production business：

- `utils/record-save-cutover-contract.js` 与 `utils/record-save-cutover-controller.js` 定义 `LEGACY_ONLY`、`SHADOW_PREVIEW`、`SHARED_CANARY`、`SHARED_PRIMARY`、`RECOVERY_LOCKED`，统一可信配置、隔离资格证据、Shared/Legacy 资格、路径和阶段化回退。生产环境无论请求何种模式都硬钳制为 `LEGACY_ONLY`。
- 当前没有可信远程配置、在线 kill switch 或活跃客户端版本覆盖率。构建 Provider 只能签发生产 Legacy；Fake/Local Provider 和证据只用于隔离环境。普通参数、Storage、环境变量、页面输入、克隆配置或普通布尔对象均不能取得 Shared 资格。当前真实回退只能依靠构建配置或重新发布。
- Shared 资格复用 SavePlan 权威 `validatePlanShape()`，并绑定 Confirmation、Preflight、state revision/fingerprint、受保护 target/Coordinator、实际 Coordinator schema、明确 clean transaction/readback/receipt/material 证据、精确 cohort policy、allowlist、生产 result/provider、Shadow 基线和 Release A/旧 writer 退出证据。当前没有生产证据签发器，真实用户不能获得 Shared 资格。
- 终局或模糊事务状态在 mode 选择前阻断。主 Bundle 可能写入、readback/receipt 不确定、已提交、stale、plan 碰撞、金融不变量失败均为 `NO_FALLBACK`；`BEFORE_JOURNAL` 也不视为安全写前阶段，因为事务协议先写 Backup。回退阶段、base/revision/fingerprint、receipt 和重验事实必须来自绑定可信 Coordinator 的受保护 outcome，普通参数不能解锁回退；可信配置的 `fallbackPolicy` 也必须明确允许该类回退。只有明确尚未创建事务材料，或严格验证回到 base 后重新读取、重做 Preflight 的场景，才可考虑 Legacy。
- `RECOVERY_LOCKED` 同时阻断 Shared 和 Legacy；配置 kill switch 只影响下一笔尚未开始的保存，不能中断或改道正在提交/恢复的事务。
- `utils/record-save-cutover-monitor.js` 只在内存保留有界技术事件，使用枚举、语义版本、config/hash 短指纹和计数；不记录原文、客户、电话、商品、金额、完整记录或自由错误文本，不写业务 Bundle、不上传远端。
- 22 个 legacy/shared 保存等价场景继续作为 Shadow 基线；`Legacy → Shared → transactional-Legacy → Shared` 仅在隔离事务协议中模拟 revision/receipt/未知字段兼容，不代表生产 transactional Legacy writer 已实现。

发布顺序必须先是 Release A 基础设施版本并继续固定 `LEGACY_ONLY`；只有能证明活跃客户端升级和旧 writer 退出后，才可设计受控内部设备 Release B canary。详细边界以 `docs/RECORD_SHARED_SAVE_CUTOVER_PLAN.md` 为准。

### 1.10 Release A RC1 当前实现状态（2026-07-23）

Release A RC1 只接入 Legacy 基础设施，不启用 Shared：

- `utils/storage.js` 是生产业务 Bundle 的唯一组合根，创建受保护 wx Gateway、
  Release A Coordinator 和本地有界监测；原有 `getState()`、`saveState()`、
  `updateState()` 和 `initializeState()` 保持同步调用形态。
- 23 个生产写入点继续运行原 Legacy 业务 mutation，但统一携带受控
  `writerSource`，最后经双 fingerprint CAS、容量预检、sealed Backup/Journal、
  单 Bundle 写入、立即读回、Receipt 与清理。
- `app.js` 在任何业务初始化前调用恢复入口。已有有效 Bundle 的普通启动只读且不增加
  revision、Receipt 或 fingerprint；只有 Bundle 不存在时才通过同一 Coordinator
  事务初始化。
- 恢复矛盾、readback 不确定或清理后状态不可确认时进入 Recovery Lock；所有 Legacy
  Bundle writer 同步失败，不能绕过 Coordinator，也不能向页面误报成功。
- 本地监测仅保留枚举事件、revision、状态和短技术字段，FIFO 有界；不写 Storage、
  不远程上传，也不记录原文、客户、电话、商品、金额、完整 state、Journal 或 Backup。
- 22 个代表保存场景已比较旧 Legacy、Shared Memory 和事务 Legacy，业务差异为 0；
  允许差异仅限 revision、事务控制 meta、Receipt 和本地技术事件。
- 微信开发者工具候选验证使用仓库外独立 Mini Program 与四个隔离 key：当前 RC
  不重载测试 16/16，五类跨重新编译恢复/幂等场景累计 6 个新 App Boot；真实业务 key
  读/写/删与白名单外访问均为 0，最终测试 key 清理为 0。该证据不等于真机、真实
  断电、真实用户数据或正式版本发布验证。

生产仍固定 `LEGACY_ONLY`，Release A Coordinator 的共享 transaction API 对普通页面
继续返回 `SHARED_PRODUCTION_COMMIT_DISABLED`。当前没有在线 kill switch 或可信客户
端版本覆盖率；下一步只能进入人工发布评审，不能开启 Shared。

## 2. 目标与非目标

### 2.1 目标

共享核心必须把同一条原文从解析一直处理到可检查的保存结果：

```text
严格原文
  ↓
输入标准化与聊天提取
  ↓
真实本地 parser
  ↓
本地安全检查与生产 route
  ↓
按模式决定是否调用 AI adapter
  ↓
AI 业务有效性检查、标准化、合并与冲突处理
  ↓
最终安全检查
  ↓
领域确认态
  ↓
savePlan（不写数据）
  ↓
MemoryStore 或真实存储适配器提交
  ↓
state diff 与完整 trace
```

微信、Web、Node 必须调用同一个平台无关编排入口，不能复制 parser、路由、合并、安全、确认态或保存转换代码。

### 2.2 非目标

本合同不决定、不实现：

- 复杂内容是否改为自动调用 AI；
- “深度核对”是否长期保留；
- 哪些危险字段需要额外二次确认；
- 网页测试台、微信自动化或真机录音；
- 真实 AI 的模型质量和成本结论；
- 数据库、云端账号或生产迁移。

## 3. 当前产品事实与兼容原则

当前真实流程是：本地 parser 先执行，`getParseRouteDecision()` 决定
`local`、`pending`、`ai_standard`、`ai_deep`。涉及历史、账款、多轮聊天、多商品、冲突或复杂语义的内容，默认常先进入 `pending`；只有用户明确选择 `reviewMode: 'deep'` 才走深度 AI。共享核心的 `PRODUCTION_ROUTING` 必须先原样复刻这套规则。

当前完整页和首页都传 `context: 'home'`，都调用 `parseHybridInput()` 和 `saveConfirmedDraft()`，但分别在 `pages/input/input.js` 与 `pages/dashboard/dashboard.js` 计算确认态。生产仍执行现有 Legacy 业务 mutation；Release A 只把最终整包状态写入接到 `utils/storage.js` 的事务 Coordinator。共享 SavePlan、Commit 仍未成为两页或 production business 的主保存路径。

兼容原则：第一阶段抽取必须先做“等价迁移”。任何路由、必填字段、保存准入或业务副作用变化，都必须另立产品任务和回归，不得藏在平台解耦中。

## 4. 共享核心边界

```text
微信页面 ─┐
          ├─ Platform Adapter ─ Record Shared Core ─ AI Adapter
Web 测试台 ┤                                      ├─ History/Query Adapter
Node 测试 ─┘                                      └─ Storage Adapter / MemoryStore
```

共享核心负责：原文保护、标准化、本地解析、安全、路由、AI 编排、有效性检查、标准化、合并、来源与证据、确认态、savePlan、内存态提交结果和 trace。

平台层只负责：采集输入、显示等待、控件与样式、用户点击、录音和剪贴板权限、页面跳转、网络与真实存储适配。平台层不得重新判断 AI 是否可信、不得另写保存闸门、不得生成另一套 savePlan。

## 5. 版本与入口

建议唯一入口：

```text
runRecordFlow(input) -> Promise<RecordFlowOutput>
```

合同版本写入每次输出：

- `coreContractVersion`: `record-shared-core-v1`
- `traceSchemaVersion`: `record-trace-v1`
- `savePlanVersion`: `record-save-plan-v1`

版本升级必须向后兼容已有测试题，或提供显式迁移器；不能静默改变同名字段语义。

## 6. 输入合同

### 6.1 RecordFlowInput

| 字段 | 类型 | 必填 | 默认/允许值 | 提供者 | 核心能否修改 | 测试注入 | 生产来源 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `mode` | 枚举 | 是 | `LOCAL_ONLY` / `AI_ONLY` / `PRODUCTION_ROUTING` | 调用方 | 否 | 每题固定 | 生产固定为 `PRODUCTION_ROUTING` |
| `originalText` | string | 是 | 非空；严格原文 | 输入适配器 | **否** | fixture 原文 | 输入框、语音转写原文或剪贴板原文 |
| `inputSource` | 枚举 | 是 | `typed` / `voice` / `chat` / `imported` / `test` | 输入适配器 | 否 | 每题固定 | 页面输入方式；旧 `paste` 映射为 `chat` |
| `businessDate` | `YYYY-MM-DD` | 是 | 无隐式默认 | 调用方/clock | 否 | 固定日期 | `clock` 按上海时区计算 |
| `businessTimezone` | string | 是 | V1 只允许 `Asia/Shanghai` | 调用方 | 否 | 固定值 | 应用公共配置 |
| `nowInstant` | ISO-8601 instant | 是 | 含时区或 `Z` | clock | 否 | 冻结时间 | clock 当前时刻 |
| `reviewMode` | 枚举 | 否 | `standard`；允许 `standard` / `deep` | 用户动作/测试题 | 否 | 每题固定 | 页面“深度核对”动作 |
| `context` | 枚举 | 否 | 兼容期默认 `home`；允许 `home` / `record` | 平台适配器 | 否 | 生产复刻用 `home` | 当前两页均为 `home`；`record` 为平台中立目标值 |
| `initialState` | DomainState | 否 | 空白业务状态 | 调用方/存储适配器 | 否；必须深拷贝 | fixture | 真实存储快照 |
| `userEdits` | UserEdit[] | 否 | `[]` | 页面/测试 | 否 | 显式步骤 | 用户对字段或关联对象的修改 |
| `userConfirmedFields` | string[] | 否 | `[]`；仅作派生摘要 | 页面/测试 | 否 | 显式步骤 | 兼容显示，不是保存授权依据 |
| `userFieldConfirmations` | UserFieldConfirmation[] | 否 | `[]` | 页面/测试 | 否 | 绑定值和 revision 的确认步骤 | 用户明确确认的危险字段及当时值 |
| `aiAdapter` | AiAdapter | 条件必填 | AI 模式需要；本地模式可用拒绝调用 adapter | 组合根 | 否 | fake/mock/replay/real canary | 微信网络适配器 |
| `storageAdapter` | StorageAdapter | 否 | 仅生成计划时可省略 | 组合根 | 否 | MemoryStore | wxStorage adapter |
| `clock` | Clock | 是 | `nowInstant()`、`businessDate(timezone)`、`monotonicMs()` | 组合根 | 否 | FrozenClock | 微信/服务运行时 clock |
| `idGenerator` | IdGenerator | 是 | `next(entityType)` | 组合根 | 否 | SequenceIdGenerator | 安全随机或现有兼容生成器 |
| `traceOptions` | TraceOptions | 否 | 见 6.4 | 调用方 | 否 | 全量、可重放 | 生产默认脱敏 |
| `runId` | string | 否 | 缺失时由 `idGenerator` 生成 | 测试运行器/核心 | 仅可补一次 | 固定或运行级 ID | 应用生成 |
| `caseId` | string | 否 | 无 | 测试运行器 | 否 | 题目 ID | 生产为空 |

`mode` 只能影响顶层编排，不得让 parser、合并器、安全函数读取环境变量或测试标志。`context` 不能作为“微信/Web/Node”的暗开关；从 `home` 迁移到 `record` 前必须先用特征测试证明结果等价。

`nowInstant` 是绝对事实；`businessDate` 必须等于它按 `businessTimezone` 投影后的日期，并与 clock 一致，否则返回 `INPUT_INVALID`。业务日期和 createdAt 使用 `nowInstant()`，耗时和截止使用 `monotonicMs()`，不得混用墙上时钟。生产输入适配器先从同一个 clock 生成三者，测试由 FrozenClock 生成。

对外和 trace 使用 `inputSource: chat`；兼容 facade 调当前遗留代码时必须执行
`chat -> paste`，遗留结果返回时执行 `paste -> chat`。该双向映射是等价迁移要求，否则当前多轮聊天和 fast/deep 判定会改变。

### 6.2 原文与派生文本

必须分开保存：

| 字段 | 含义 | 规则 |
| --- | --- | --- |
| `originalText` | 用户实际提交的严格原文 | 不 trim、不改空格、不改换行、不纠错；全链路只读 |
| `normalizedText` | 为 parser 统一字符、空格、数字表达后的文本 | 由核心派生；不能覆盖原文 |
| `extractedText` | 从聊天或导入内容中选出的业务文本 | 由输入提取阶段派生 |
| `rawMessages` | 解析后的原始消息对象数组 | 保留顺序、说话人标签与原句；不得替代严格原文 |
| `selectedMessages` | 本次被纳入解析的消息索引或 ID | 必须可追溯到 `rawMessages` |

当前 `utils/parser.js` 的 `original_text` 会做一定归一化，`utils/clipboard-chat.js` 已能区分
`rawText`、`extractedText` 和消息。目标实现必须新增严格原文槽位，并对旧字段做兼容映射，不能立即改坏历史页面。

### 6.3 UserEdit

每次修改是事件，不是只传最终对象：

```json
{
  "fieldPath": "items[1].quantity",
  "oldValue": "",
  "newValue": "200",
  "editedAt": "2026-07-22T02:00:00.000Z",
  "confirmed": true
}
```

核心按顺序应用编辑，然后重新执行字段来源更新、关联候选检查、最终安全、确认态和 savePlan。不能只删除当前字段的 warning 就视为所有风险已解除。

`UserFieldConfirmation` 至少包含 `fieldPath`、`valueHash`、`resultRevision`、
`confirmedAt`。字段值、来源、关联候选、intent 或 operation 变化后，相关确认立即失效；多商品确认绑定稳定 itemId 和字段路径，不能只用 `items` 一个名字笼统确认。`userConfirmedFields` 只能由仍有效的确认事件派生。

### 6.4 TraceOptions

至少支持：

- `level`: `minimal` / `full`；
- `includeRawAi`: 是否保存 AI 原始结构；
- `includeStateSnapshots`: 是否记录 stateBefore/stateAfter；
- `redaction`: `production` / `synthetic_test`；
- `maxTextLength` 与 `maxHistoryRecords`。

生产 trace 默认脱敏；真实密钥、授权头、Cookie 永远不得进入 trace。

## 7. 三种运行模式

| 能力 | `LOCAL_ONLY` | `AI_ONLY` | `PRODUCTION_ROUTING` |
| --- | --- | --- | --- |
| 真实本地 parser | 必须执行 | 必须以影子方式执行，仅生成 productionRoute/trace | 必须执行 |
| 本地结果能否决定最终字段 | 是 | **否** | 按真实合并规则 |
| 生产 route 判断 | 记录但不发 AI | 不作为 AI 调用条件 | 必须执行并服从 |
| AI adapter | 严禁调用 | 必须调用 | 仅 route 为 AI 时调用 |
| AI 业务有效性检查 | 不适用 | 必须 | 调用后必须 |
| 最终安全 | 必须 | 必须 | 必须 |
| confirmation/savePlan | 必须 | 必须 | 必须 |
| MemoryStore 提交 | 可选且显式 | 仅测试可选且显式 | 可选且显式 |

### 7.1 LOCAL_ONLY

- 使用真实本地 parser 和本地安全检查。
- 注入的 AI adapter 应为 `FailOnCallAiAdapter`；任何调用都以
  `AI_CALLED_IN_LOCAL_ONLY` 使测试失败。
- 即使真实 route 认为需要 AI，也不发请求；trace 必须同时记录“生产 route 本应是什么”和“本模式禁止 AI”。
- 继续生成最终安全、确认态、savePlan；只有安全允许时才可提交 MemoryStore。
- 用于测量本地正确率、错误高置信、危险放行与简单输入完整保存。

### 7.2 AI_ONLY

- 原文直接交给与生产相同输入/输出合同的 AI adapter。
- 必须运行本地 parser 和 route 生成只写 trace 的 `shadowLocalResult` 与 `productionRoute`，便于同题观察分流；但它们不得进入 AI 请求、prompt、标准化输入或最终 AI_ONLY 字段。AI_ONLY 请求必须省略 `localDraft`（或显式 `localDraftPolicy: OMIT`）；否则不能称为模型/prompt 单独评分。
- AI 仍必须经过业务有效性检查、原文/历史证据检查和最终保存安全；“只测模型”不等于允许绕过安全。
- 历史数据只来自 `initialState` 的明确 fixture。找不到或不唯一时，AI 应返回缺失/冲突/需确认，不得编历史价格或 ID。
- 可以生成 savePlan；仅当测试显式设置执行步骤、最终安全通过且 providerKind 符合规则时，才可提交 MemoryStore。生产页面不暴露 AI_ONLY。
- 模型评分只读取 `rawModelContent` 与 `parsedBusinessResult`；标准化、确认态、保存层错误不能反算成模型错误。

### 7.3 PRODUCTION_ROUTING

严格复刻当前产品：

```text
本地 parser → 本地安全 → getParseRouteDecision 等价实现
  ├─ local：不调用 AI
  ├─ pending：不调用 AI，显示补充/深度核对
  ├─ ai_standard：调用 standard adapter
  └─ ai_deep：仅 reviewMode=deep 等当前条件成立时调用 deep adapter
→ 标准化 → 合并 → 最终安全 → confirmation → savePlan → 可选提交
```

该模式用于统计真实分流、合并、危险放行、不必要调用和失败回退。测试模式不得把 `pending` 偷改成自动 AI。

## 8. AI Adapter 合同

### 8.1 接口

```text
aiAdapter.parse(AiParseRequest) -> Promise<AiParseResponse>
```

核心不得直接使用 `wx.request`、HTTP 地址、provider SDK 或环境变量。网络认证、HTTP 与模型调用都在 adapter 外层。

每个 adapter 在组合根注册不可变 `descriptor`：`adapterId`、`providerKind`、
`provider`、允许的 modelTier 和是否可访问网络。providerKind 的权威来源是 descriptor，不能来自模型业务 JSON，也不能被 AiParseResponse 覆盖；core 必须校验响应身份和 descriptor 一致。

### 8.2 AiParseRequest

| 字段 | 说明 |
| --- | --- |
| `requestId` | 本次唯一请求 ID |
| `mode` | 只作为 trace 元数据；adapter 不得据此改变 prompt、model 或 output shape |
| `reviewMode` | `standard` / `deep` |
| `originalText` / `normalizedText` | 严格原文与归一化文本 |
| `inputSource` | 规范输入来源 |
| `businessDate` / `businessTimezone` | 模型解释相对日期的唯一基准 |
| `localDraft` | 仅 PRODUCTION_ROUTING 传生产本地草稿；AI_ONLY 必须省略或为空 |
| `businessContext` | 已按客户和策略缩小范围的历史数据；空即无可用历史 |
| `rawMessages` / `selectedMessages` | 聊天证据与顺序 |
| `requiredOutputShape` | 生产 standard/deep 对应的结构合同 |
| `deadlineMs` | 基于 `clock.monotonicMs()` 的绝对单调截止点，不是 epoch 时间 |
| `traceContext` | `runId`、`caseId`，不含密钥和业务写权限 |

### 8.3 AiParseResponse

| 字段 | 类型/规则 |
| --- | --- |
| `providerKind` | 从 adapter descriptor 复制的 `NONE` / `REAL` / `MOCK` / `FAKE` / `REPLAY` |
| `provider` | 供应商标识，不含账号或密钥 |
| `model` | 实际模型标识 |
| `modelTier` | `fast` / `quality` / 其他显式枚举 |
| `promptVersion` | 人工版本号；生产 prompt 变更必须更新 |
| `promptHash` | 规范化 system+user 模板的内容哈希 |
| `requestId` | 与请求一致；服务端可附 `serverRequestId` |
| `startedAt` / `finishedAt` / `latencyMs` | adapter 实际调用时间 |
| `rawProviderResponse` | provider 包装的安全摘要或测试全量；生产按脱敏规则保存 |
| `rawModelContent` | 模型原始字符串；空/非 JSON 的第一层评分依据 |
| `parsedBusinessResult` | 对原始模型内容完成 JSON 提取后的业务对象，尚未字段标准化 |
| `usage` | input/output/total token 与可得的计费元数据 |
| `error` | `{code,message,retryable,httpStatus}`；不含响应密钥或敏感头 |

`REAL` 只代表真实 provider 确实被请求，不代表结果正确；`MOCK`、`FAKE`、`REPLAY` 永远不能记为真实模型成功。确定性测试可以让 `FAKE`/`REPLAY` 的业务内容经过解析、标准化和 Confirmation 以验证前序路径，但当前 Phase 1E.1 的正式 SavePlan 必须阻断这些 provider，operations 为空；测试若需验证 Commit 成功路径，应使用完全合成、受信的生产模式本地结果，不得提升 provider 身份。

### 8.4 失败返回规则

AiParseResponse 是判别联合：成功返回 `ok: true`，预期的 provider/网络/格式失败返回
`ok: false` 和结构化 `error`。adapter 不得在失败时填入本地字段。即使第三方 SDK 以 reject/throw 报错，core 也必须捕获、映射并返回带原文和完整 trace 的安全 output；只有输入合同或核心编程错误可以终止整次调用。

| 场景 | adapter调用/网络开始/收到响应 | `aiRequestState` | `aiOutcome` | 最低错误码 |
| --- | --- | --- | --- | --- |
| route 需要 AI 但无 endpoint | 否 / 否 / 否 | `SKIPPED` | `SKIPPED_NO_ENDPOINT` | `AI_ENDPOINT_MISSING` |
| 401 | 是 / 是 / 是 | `FAILED` | `FAILED` | `AUTH_REQUIRED` |
| 403 | 是 / 是 / 是 | `FAILED` | `FAILED` | `AUTH_FORBIDDEN` |
| 429 | 是 / 是 / 是 | `FAILED` | `FAILED` | `RATE_LIMITED` |
| 5xx | 是 / 是 / 是 | `FAILED` | `FAILED` | `AI_PROVIDER_FAILED` |
| 网络错误 | 是 / 是 / 否 | `FAILED` | `FAILED` | `AI_NETWORK_ERROR` |
| 超时 | 是 / 是 / 否或迟到丢弃 | `TIMED_OUT` | `TIMED_OUT` | `AI_TIMEOUT` |
| 空响应/非 JSON | 是 / 是 / 是 | `SUCCEEDED` | `INVALID_RESPONSE` | `AI_RESPONSE_INVALID` |
| 合法空业务 JSON | 是 / 是 / 是 | `SUCCEEDED` | `EMPTY_BUSINESS_RESULT` | `AI_RESPONSE_EMPTY_BUSINESS` |

任何失败映射都必须令 `blocksFormalSave=true`（纯 local route 不适用），并保持本地草稿只是草稿，不能包装成 `USED`。

## 9. 状态合同

### 9.1 ProviderKind

- `NONE`：没有 provider；
- `REAL`：真实模型网络调用；
- `MOCK`：产品模拟 provider；
- `FAKE`：确定性测试 adapter；
- `REPLAY`：读取已保存响应。

REPLAY 可用于页面开发和标准化回归，不能计入模型正确率、真实延迟、稳定性或当轮成本。

### 9.2 AI 请求/结果状态

`aiOutcome` 是本次 AI 工作的结果，不表达最终是否采用：

- `NOT_REQUESTED`
- `REQUESTING`（只用于事件流/进行中快照）
- `USED`
- `RETURNED_UNCERTAIN`
- `FAILED`
- `TIMED_OUT`
- `MOCK_USED`
- `INVALID_RESPONSE`
- `EMPTY_BUSINESS_RESULT`
- `SKIPPED_NO_ENDPOINT`

必须同时保留低层 `aiRequestState`：`NOT_REQUESTED`、`DECIDED`、`REQUESTING`、`SUCCEEDED`、`FAILED`、`TIMED_OUT`、`SKIPPED`。HTTP 200 只可使 requestState 成为 `SUCCEEDED`，不能直接得到 `USED`。

### 9.3 采用状态

请求状态与字段采用必须分开：

- `NOT_APPLICABLE`：未请求 AI；
- `ADOPTED`：有效 AI 结果成为主要最终结果；
- `PARTIALLY_ADOPTED`：只采用部分 AI 字段；
- `NOT_ADOPTED`：AI 返回但因冲突、无证据、mock、用户覆盖或安全拒绝而未采用。

AI 成功返回但最终未采用必须记录 `aiOutcome: USED` 与
`adoptionStatus: NOT_ADOPTED`，不能改写成失败，也不能假装 AI 贡献了字段。

### 9.4 当前状态映射

| 当前 `ai_fallback.status` | V1 `aiOutcome` | 备注 |
| --- | --- | --- |
| `not_requested` | `NOT_REQUESTED` | 含 local/pending 未请求 |
| `requested` | `REQUESTING` | 当前也被用于请求前草稿；目标应拆 request state |
| `used` | `USED` | 还须 `business_result_valid=true` |
| `returned_uncertain` | `RETURNED_UNCERTAIN` | 空业务错误目前也映射到此，目标要独立码 |
| `failed` | `FAILED` | 保留具体 error code |
| `timed_out` | `TIMED_OUT` | 保留 fast/deep/总等待超时码 |
| `mock_used` | `MOCK_USED` | 正式保存必须阻断 |
| `skipped_no_endpoint` | `SKIPPED_NO_ENDPOINT` | 没有环境或 endpoint |

### 9.5 核心错误码

至少定义：`INPUT_INVALID`、`MODE_INVALID`、`AI_ADAPTER_REQUIRED`、
`AI_CALLED_IN_LOCAL_ONLY`、`AI_RESPONSE_INVALID`、
`AI_RESPONSE_EMPTY_BUSINESS`、`AI_TIMEOUT`、`AI_PROVIDER_FAILED`、
`AI_ENDPOINT_MISSING`、`AI_NETWORK_ERROR`、`AUTH_REQUIRED`、`AUTH_FORBIDDEN`、
`RATE_LIMITED`、`MOCK_NOT_TRUSTED`、`HISTORY_NOT_FOUND`、`HISTORY_AMBIGUOUS`、
`ROUTE_CONTRACT_VIOLATION`、`SAFETY_BLOCKED`、`SAVE_PLAN_INVALID`、
`STORAGE_COMMIT_FAILED`、`STORAGE_ROLLBACK_FAILED`、`STATE_DIFF_MISMATCH`。

错误对象必须带 `stage`、`code`、`message`、`retryable`、`blocksFormalSave`；用户文案由页面适配器映射，核心不返回平台 Toast。

## 10. AI 业务结果有效性

### 10.1 无效结果

以下结果必须得到 `EMPTY_BUSINESS_RESULT` 或 `INVALID_RESPONSE`，不得标记 `USED`：

- `{}`；
- `{ "fields": {} }`；
- 空 `intent`；
- `intent: "unknown"` 且没有具体业务判断；
- `items: []` 且无其他业务结论；
- 只有空的 missing/low/conflict 数组；
- 只有 provider、model、requestId、timing、token、status、metadata；
- 业务字段全部为空白；
- 结构合法但没有业务结论。

### 10.2 有效安全结论

以下不是“空结果”，但通常仍会阻止正式保存：

- 明确信息不足并列出缺失字段；
- 明确要求用户确认并说明原因；
- 明确存在冲突或历史匹配不唯一；
- 明确不能可靠形成业务记录；
- 明确是 `NO_RECORD`；
- 明确不能引用不存在的历史价格或订单。

### 10.3 有效业务结论

至少满足一项：

1. 有明确且受支持的 intent；
2. 至少一个有原文或历史证据的业务字段；
3. 有明确、具体的不确定/冲突/缺失结论；
4. 有明确 `NO_RECORD` 或需用户确认结论；
5. 有结构正确且有证据的 `items[]`、多事项或历史关联结果。

### 10.4 五层防护

有效性检查必须在以下边界存在，且共享同一规则包：

1. 服务端收到模型结构后；
2. 客户端/核心标准化前；
3. 合并前；
4. confirmation 计算前；
5. 正式保存闸门。

当前 P0 已在服务端、客户端和 business 闸门修复并有 Node 针对性回归；合同将其固化为不可回退规则，而不是把 P0 重新标成未修。

## 11. 输出合同

### 11.1 RecordFlowOutput

```text
{
  coreContractVersion,
  result,
  trace,
  confirmation,
  savePlan,
  businessResult,
  metrics,
  errors
}
```

当正式保存被阻断时也必须返回完整 output；不得用 throw 丢失原文、route、确认态或待整理计划。adapter reject/合同违例也应先映射为安全 output 和错误；只有输入合同损坏或无法继续的核心编程异常才终止。

### 11.2 result

至少包含：

- `intent`、`operation`；
- `fields`、`items`；
- `drafts[]`：多事项的候选业务草稿；当前生产规则未允许自动拆分保存时必须保持阻断；
- `missingFields`、`lowConfidenceFields`、`fieldConflicts`；
- `confidence`；
- `formalSaveBlocked`；
- `originalText`、`normalizedText`、`extractedText`；
- `fieldSources`、`fieldEvidence`；
- `finalSource`: `local` / `ai` / `mixed` / `user` / `pending` / `no_record`。

规范输出使用 camelCase；兼容层负责映射当前 snake_case，页面和测试不得各自再写映射。

### 11.3 trace

至少包含：

- 身份：`runId`、`caseId`、`mode`、`inputSource`；
- 原文：`originalText`、`normalizedText`、`extractedText`；
- 本地：`localResult`、`localSafety`、`localConfidence`、`localWarnings`；
- 路由：`productionRoute`、`executionPath`、`routeReasons`、`deepReviewAvailable`；
- AI：`aiRequiredByRoute`、`aiAdapterInvoked`、`aiRequestStarted`、
  `aiResponseReceived`、`aiRequestState`、`aiOutcome`、`providerKind`、
  `provider`、`model`、`modelTier`、`promptVersion`、`promptHash`、
  `rawProviderResponse`、`rawModelContent`、`parsedBusinessResult`、
  `aiNormalizedResult`、`aiError`；
- 合并：`mergeResult`、`mergeConflicts`、`fieldSources`、`fieldEvidence`、
  `adoptionStatus`；
- 最终：`finalSafety`、`saveAllowed`、`saveBlockedReasons`、`finalSource`；
- 时间：`startedAt`、`finishedAt`、`localLatencyMs`、`aiLatencyMs`、
  `totalLatencyMs`；
- 保存：`savePlanSummary`、`businessResultSummary`。

trace 是事件事实，不是用户文案。任何阶段不得修改上一步 trace；只能追加新 stage。

上述 raw 与 state 字段是逻辑 trace 能力，不等于生产日志必须持久化全量内容。`traceOptions` 为 full synthetic test 时保存合成全量；生产可返回/持久化 `redacted`、hash 或安全引用，并明确 `redacted=true`，不得保存完整客户 state 或敏感模型原文。

`productionRoute` 记录同一输入按当前产品规则本应得到的规范枚举 `LOCAL`、`PENDING`、
`AI_STANDARD` 或 `AI_DEEP`；`executionPath` 记录本模式实际执行的
`LOCAL_ONLY`、`AI_ONLY_STANDARD`、`AI_ONLY_DEEP`、`PRODUCTION_LOCAL`、
`PRODUCTION_PENDING`、`PRODUCTION_STANDARD` 或 `PRODUCTION_DEEP`。遗留小写值只保留在 rawValue 和兼容输入中。AI
分流正确率只按 `productionRoute` 计算，不能把 LOCAL_ONLY 的禁止调用或 AI_ONLY
的强制调用误算成生产分流错误。

`SKIPPED_NO_ENDPOINT` 必须记录 `aiRequiredByRoute=true`，但
`aiAdapterInvoked=false`、`aiRequestStarted=false`、`aiResponseReceived=false`。
这些事件字段不能从 route 或最终 outcome 反推，必须按真实发生过程记录。

### 11.4 confirmation

平台无关领域确认态至少包含：

- `businessType`、`operation`；
- 只读 `originalText`；完整页和首页都必须可查看，首页可折叠但不能删除；
- `visibleFields`、`mustDisplayFields`、`editableFields`、`requiredFields`、`recommendedFields`、`optionalFields`；
- `warnings`、`fieldConflicts`、`fieldEvidence`；
- `customerCandidates`、`orderCandidates`、`receivableCandidates`；
- `domainCanSaveFormal`（兼容别名 `canSaveFormal`）、`canSavePending`；
- `canCommitToRealStorage`（非 REAL 的 AI 模拟成功路径必须为 false）；
- `formalSaveDisabledReason`；
- `needsUserConfirmation`、`needsDeepReview`、`requiresFullPage`；
- `requiredSurfaceCapabilities`；
- 完整 `items[]` 的逐项确认状态；
- `confirmationVersion`。

该对象表达业务事实，不包含 `setData` 字段、CSS class、按钮位置、折叠状态或 Toast 文案。

### 11.5 savePlan

savePlan 只描述“准备怎样写”，不能修改状态：

- `planId`、`version`、`intent`、`operation`；
- `customersToCreate`、`customersToUpdate`；
- `quotationsToCreateOrUpdate`；
- `ordersToCreateOrUpdate`；
- `receivablesToCreateOrUpdate`；
- `paymentsToCreate`；
- `todosToCreateOrUpdate`；
- `pendingNotesToCreate`；
- `recordLinks`；
- `writes[]`（所有主记录、派生记录和审计写入的单一权威列表）；
- `originalText`；
- `preconditions`；
- `expectedStateDelta`；
- `formal` 与 `blockedReasons`；
- `commitTargetPolicy`: `REAL_OR_MEMORY` / `MEMORY_ONLY` / `BLOCKED`。

`prepareSavePlan()` 必须是纯函数。若正式保存不安全，只能返回 operations 为空的阻断计划；不得把调用方请求的 `SAVE_FORMAL` 自动改写成待整理。只有用户明确请求 `SAVE_PENDING` 时才能生成仅含待整理记录的计划。LOCAL_ONLY、AI_ONLY、FAKE、MOCK、REPLAY 均不得生成可提交的正式计划。

每条 `WriteOperation` 至少包含：

```text
{
  writeId,
  entityType,
  action,             // CREATE / UPDATE / DELETE
  recordId,
  dataOrPatch,
  dependsOn[],
  preconditions[],
  expectedRevision,
  idempotencyKey,
  requiresOriginalText
}
```

上面的分类数组是方便阅读的投影，必须可由 `writes[]` 唯一推导，不能形成第二套计划。`writes[]` 还必须表达当前运行时的 `orderProgress`、`aiParseLogs`、`operationLogs`、`productCatalog` 和兼容 `dunningRecords` 等派生/审计写入；等价迁移时不能只保存主记录、静默丢掉当前副作用。

### 11.6 businessResult

提交后至少包含：

- `createdRecords`、`updatedRecords`、`deletedRecords`；
- `stateBefore`、`stateAfter`、`stateDiff`；
- `commitSucceeded`、`commitErrors`；
- `commitStatus`: `NOT_ATTEMPTED` / `BLOCKED` / `SUCCEEDED` / `FAILED` / `ROLLED_BACK`；
- `rolledBack`；
- `appliedPlanId`；
- `idempotentReplay`、`originalCommitResultRef`。

`NOT_ATTEMPTED` 时 stateAfter 必须等于 stateBefore 且 stateDiff 为空；`BLOCKED` 表示计划、授权或目标存储不允许提交；`FAILED` 只能出现在尚未产生可见写入时；发生部分内部写入后必须回滚并返回 `ROLLED_BACK`；只有全部写入和后置校验通过才是 `SUCCEEDED`。

合成测试可返回完整 stateBefore/stateAfter；生产 trace/日志默认只返回 revision、diff 摘要和受控 record references，不持久化整份客户状态。

### 11.7 metrics 与 errors

`metrics` 至少包含本地、AI、合并、安全、计划和提交各阶段耗时、AI 请求次数、是否发生重试、处理的消息/商品/事项数量。REAL adapter 可附 token 和费用估算；FAKE/MOCK/REPLAY 的费用必须为 `not_applicable`，并保留 providerKind。

`errors[]` 必须保留全部结构化错误，至少含 `stage`、`code`、`message`、`retryable`、`blocksFormalSave`、`fieldPaths`。一个早期错误被安全回退处理后仍要留在 errors 和 trace，不能因最终生成待整理而被抹掉。

## 12. 字段来源与证据

### 12.1 来源枚举

- `LOCAL`
- `AI`
- `HISTORY`
- `USER`
- `DERIVED`
- `DEFAULT`
- `UNKNOWN`

### 12.2 FieldFact

每个最终字段以及 `items[n].*`、关联 ID 必须使用同一语义记录：

```text
{
  value,
  source,
  evidence[],
  confidence,
  confirmedByUser,
  lastUpdatedStage
}
```

至少覆盖 `customerName`、`productName`、`quantity`、`unit`、`unitPrice`、
`totalAmount`、`paymentAmount`、`receivableAmount`、`depositAmount`、
`remainingAmount`、所有日期、`items[]` 与 customer/order/quotation/receivable ID。

规则：

- 用户修改后来源立即变为 `USER`；
- 计算剩余金额为 `DERIVED`，并记录公式和输入字段；
- “上次价格”只有成功匹配历史记录时为 `HISTORY`，证据带记录 ID；
- 默认值为 `DEFAULT`，不能冒充原文事实；
- AI 危险字段没有证据时不得正式采用；
- 值被覆盖时来源和证据必须一起更新，不能保留旧 AI 来源；
- 多商品逐项记录，不能只给整个 `items` 一个模糊来源。

当前 `field_sources` 只做浅合并，`manual_fields` 也未可靠更新最终来源。这是已知 P1 差距，本轮不修。

## 13. 三层安全合同

### 13.1 本地解析安全

输出当前四态：

- `SAFE_LOCAL`
- `NEEDS_AI`
- `NEEDS_USER_CONFIRM`
- `NO_RECORD`

必须记录缺失、低置信、冲突、证据不足、语义风险和原文依据。该层不能决定真实保存，只决定本地草稿风险。

### 13.2 AI 与合并安全

必须检查：

- AI 业务结果有效性；
- AI 字段是否有原文/历史证据；
- 本地与 AI 的字段、intent 和关联冲突；
- 历史引用是否唯一且属于同一客户；
- 多商品是否丢失、折叠或拼进单字段；
- 客户是否被背景数据错误覆盖；
- AI 返回的安全拒绝是否被错误当成空结果。

输出 `SAFE_TO_CONFIRM`、`NEEDS_USER_CONFIRM`、`BLOCKED_FOR_FORMAL_SAVE` 或
`NO_RECORD`，以及可追溯原因。

### 13.3 正式保存安全

在页面按钮和存储提交前都执行同一规则：

- 必填字段、低置信、冲突；
- 客户身份与重名；
- 收款/欠款方向与金额；
- 订单、报价、待收关联及目标是否唯一；
- AI outcome、providerKind、adoptionStatus；
- 用户确认的危险字段；
- savePlan 的前置条件和内部金额一致性；
- originalText 与 items[] 完整性。

### 13.4 零容忍阻断

以下任一存在时不得正式保存：

- 收款和欠款方向不确定；
- 客户归属不确定或重名未选；
- 金额、数量、定金或剩余金额冲突；
- 当 `aiRequiredByRoute=true` 或 AI 字段实际进入候选结果时，AI 为空、失败、无证据或未被采用；纯 local 的 `NOT_APPLICABLE` 不构成 AI 阻断；
- 多商品被丢失或压成一项；
- 历史记录匹配不唯一；
- 本应更新旧记录却未选择目标；
- providerKind 为 `MOCK` 的结果；或 `FAKE`、`REPLAY` 计划试图提交真实存储；
- 在老板另行决定并发布版本化策略前，任何 AI 路线失败；
- 多事项未拆分或未经确认。

## 14. 领域确认态与页面边界

共享核心是 `domainCanSaveFormal`、`canSavePending`、必填、风险、候选关联和深度核对需求的唯一权威。`requiredFields` 才能阻断正式保存；`recommendedFields` 只能提示且不得自动编造。

页面负责：样式、展开收起、控件、按钮布局、跳转、等待提示和文案展示形式。

首页可以少显示字段、遇复杂场景跳完整页、不提供完整编辑能力。页面可依据核心给出的 `requiredSurfaceCapabilities` 计算
`canSubmitHere = domainCanSaveFormal && surfaceCapabilitiesSatisfied`；页面只能收紧，不能放宽。页面能力不足记为 `SURFACE_CAPABILITY`，不冒充领域安全失败。首页还不得：

- 使用另一套保存安全规则；
- 独立判断 AI 是否可信；
- 独立生成 savePlan；
- 对同一最终字段得出不同正式保存结论。

用户修改后，核心必须从编辑事件重新计算字段来源、缺失、低置信、冲突、候选关联、AI 未解决状态、confirmation 和 savePlan，并使旧 revision、旧计划和旧确认失效。`returned_uncertain` 默认仍阻断正式保存；只有符合下节完整合同的真实用户解决才能解除聚合阻断。字段碰巧非空、页面曾被打开、普通 manual 字段名或 AI 声称“已确认”均不能解锁。

### 14.1 `returned_uncertain` 的用户解决合同

`returned_uncertain` 是原始 AI 结果，必须保留用于审计，不能被改写成 `used`。当且仅当以下事实同时成立时，核心可以派生独立的用户解决状态，例如 `MANUAL_RESOLUTION_COMPLETE`：

1. AI provider 是当前生产链确认的真实 provider，且返回了业务有效但不确定的结果；
2. 每个允许人工解决的风险都有精确字段路径；多商品风险必须精确到稳定 `itemKey + field`；
3. 用户通过真实确认页编辑、删除或合法结构调整解决了对应风险；
4. 用户证据绑定当前确认 revision、当前风险、当前字段值和当前商品身份，旧解析、旧值、旧商品或旧风险的确认不得复用；
5. AI、fixture、provider payload、replay 和普通业务字段都不能创建或覆盖用户解决证据；
6. 所有允许人工解决的风险均已解决，且不存在任何不可人工覆盖的阻断；
7. 编辑后的完整结果重新执行 final safety、domain preflight、必填、金额与商品一致性及关系检查；
8. 用户重新明确执行 `SAVE_FORMAL`，保存继续遵守原子性与失败零 mutation 合同。

允许精确编辑解决的风险包括客户、交期、金额选择以及商品名称、规格、数量、单位、单价等字段风险。用户可以补充 `originalText` 中没有的真实事实；该值的来源是 `USER_MANUAL`，不能描述为 AI 识别正确，且 `originalText` 必须继续保存最初输入，不得改写成确认卡内容。

普通字段编辑不得覆盖其他字段风险、没有精确路径的商品身份或结构冲突、报价/订单/来源关系冲突、非法付款类型、Fake/Replay/未知 provider、非生产 scope、系统异常、storage/transaction 异常和 operation replay/幂等问题。删除或重新整理商品只有在结构风险经当前数据重新计算后确实消失时才成立，不能用一个宽泛 manual 标记直接覆盖。

领域层每次都必须根据可信用户证据和当前风险重新派生用户解决状态；不得信任 payload 中声明的 `USER_RESOLVED`、`allRisksResolved` 或等价布尔值。正式保存失败时，customers、orders、orderProgress、pending、parse logs、quotations、receivables、payments 和 todos 均不得产生部分写入。

### 14.2 客户端用户回答 provenance 威胁模型

`USER_ASSISTANT_ANSWER` 是当前确认会话内的来源与完整性标记，不是身份认证、服务端授权、模型权限或正式保存授权。它只能证明：货小玲随包发布的一方确认页回答处理入口，曾把该入口接收的一次回答值绑定到当前会话、草稿 revision、原文指纹、问题、风险、商品、字段和值，并重新执行客户端安全计算；它不证明物理点击、触摸或人类在场。

当前客户端信任边界如下：

- 随包发布并经过审查的一方生产 JavaScript 属于同一个 Trusted Computing Base（TCB）。真实回答处理入口是 `pages/input/input.js`；proof challenge 与签发逻辑位于 `utils/parse-safety.js`。签发 API 的生产调用者必须由静态调用图门禁限制在这条固定链路内。
- AI、Provider、HTTP JSON、普通对象、页面参数、dataset 标量、`field_sources`、`manual_fields`、storage 数据、fixtures、replay、JSON clone、对象展开、过期问题、过期 proof、过期 context 和迟到异步回调全部是不可信数据。它们不能凭字段名、字符串、布尔值或对象形状获得 proof authority；复制普通对象或 challenge 不能产生新的 authority。复制一个当前有效的已签名 proof 不扩大其原有绑定语义，仍须通过全部上下文与当前值校验。
- 现有旧链路仍可能把 `manual_fields` 投影成页面 `USER` 来源；这是 12.2 已记录的兼容差距，不等于获得 `USER_ASSISTANT_ANSWER` proof，不能解除 `returned_uncertain` 的 proof 门禁，也不能授权服务端、domain 或保存。
- challenge 的对象身份只能由 TCB 内部创建和一次性消费；JSON clone、spread、`Object.assign` 和深拷贝不得复制 authority。可序列化 proof 仍必须严格绑定并校验 confirmation session、draft revision、originalText fingerprint、question、risk、item、field 和当前 value。
- 同一 JavaScript 权限域内的恶意一方生产模块，主动导入并滥用内部签发 API，明确不属于本阶段威胁模型。CommonJS/微信小程序客户端模块之间不存在可据此宣称的进程级安全沙箱；本阶段使用代码审查和静态调用图治理该风险，不把架构约束描述成不可伪造的模块权限。
- proof 不能绕过 final safety、domain preflight、业务必填、金额/商品/关系一致性、Provider 身份、幂等或原子保存门禁，也不能自动触发保存。页面仍必须在用户明确执行 `SAVE_FORMAL` 后走完整保存链路。
- 服务端不得仅凭客户端传来的 `USER_ASSISTANT_ANSWER`、其他 `USER_*` 标签、proof 对象或“已人工确认”布尔值跳过服务端事实检查、模型路由权限、安全校验或正式业务 mutation 门禁。客户端 provenance 只能作为受限输入，不能升级为服务端 capability。

因此，本合同防御的是不可信数据伪造、challenge authority 复制、陈旧或跨上下文重放，不宣称防御已进入同一客户端 TCB 的恶意代码。若未来要防御同进程恶意模块，必须引入 JavaScript 权限域之外的可信根或平台级事件证明，并另行版本化合同。

## 15. 保存计划、MemoryStore 与原子性

### 15.1 分离原则

```text
prepareSavePlan(result, confirmation, stateSnapshot)
  → 只生成计划，不改数据

commitSavePlan(plan, commitAuthorization, storageAdapter)
  → 校验前置条件，原子应用或完整回滚
```

`runRecordFlow()` 默认只运行到 Confirmation，`savePlan=null`；仅当调用方显式给出 `prepareSavePlan=true` 和 `SAVE_FORMAL` / `SAVE_PENDING` 时才生成计划，且绝不自动 commit。只有用户明确点击“正式保存”或“待整理”后，平台才能调用 Commit。Phase 1E.1 只有 MemoryStore 执行器；微信真实存储与页面仍走旧入口，待 Phase 1E.2 再接入同一 SavePlan。

`commitAuthorization` 至少绑定 `planId`、`planHash`、`idempotencyKey`、`confirmationId`、
`confirmationRevision`、`confirmationContentHash`、`preflightFingerprint`、`action`、
`userInitiated: true`。任何字段、来源、候选关联、风险、intent、operation 或 expected diff 改变后，旧 confirmation、savePlan 和授权全部失效。Phase 1E.1 已在 MemoryStore Commit 中执行该绑定；未来真实存储 adapter 也必须拒绝缺少用户动作、revision 过期或 hash 不匹配的提交。

### 15.2 MemoryStore

第一阶段 MemoryStore 必须：

- 从 `initialState` 深拷贝开始；
- 每题新实例，禁止跨题污染；
- 支持客户、报价、订单、待收、收款、提醒、待整理及关联查询；
- 使用 FrozenClock 与固定 IdGenerator；
- 先校验所有 preconditions，再应用 writes；
- 任一步失败恢复 stateBefore；
- 输出稳定、可比较的 state diff；
- 不调用 `wx`、网络或真实数据库。
- 用 `planId + idempotencyKey` 防重复：同一计划重复提交不新增第二份记录；本次返回 `idempotentReplay=true`、`originalCommitResultRef`，并令本次 stateBefore=stateAfter、diff/created/updated 为空。

V1 `DomainState` 的空白底座必须显式包含 `meta`、`customers`、`quotations`、
`orders`、`receivables`、`paymentRecords`、`dunningRecords`、`todos`、
`orderProgress`、`pendingNotes`、`aiParseLogs`、`operationLogs`、`productCatalog`、
`dunningTemplates` 和兼容的删除/归档集合。若未来改名为通用 `templates`，必须提供显式双向兼容映射；缺少集合时由版本化纯迁移器补固定默认值，不能调用当前时间或随机 ID。

### 15.3 必须原子处理的组合

- 创建客户 + 创建报价/订单/待收/提醒；
- 订单 + 定金；
- 收款记录 + 待收余额/状态更新；
- 报价转订单 + 报价状态/关联更新；
- 新建待收 + 同时记录已收款。

中间失败时不得留下半个客户、孤立付款或只更新一边的关联。`stateDiff` 必须为空或显示完整回滚。

### 15.4 StorageAdapter

统一存储适配器至少提供：

- `kind`: `MEMORY` / `WX_STORAGE` / 未来显式类型；
- `snapshot()`：返回带 revision 的深拷贝状态；
- `query(snapshot, querySpec)`：只读查询客户和业务记录；
- `commit(plan, commitAuthorization, expectedRevision)`：校验授权、版本和全部前置条件后原子提交；
- `rollback(transactionId)`：仅在 adapter 有可验证事务/恢复协议时提供；不能仅因整状态调用一次 `setStorageSync` 就声明 `supportsAtomicReplace=true`；
- `capabilities`：是否可写真实数据、是否支持事务和最大状态大小。

核心不能直接调用 `wx.getStorageSync`/`wx.setStorageSync`。wxStorage adapter 可继续使用当前“读完整 state、写完整 state”的兼容方式，但必须先在内存应用并校验完整计划，最后只做一次正式替换；revision 冲突时不得覆盖较新状态。Phase 1E.2A 的 legacy adapter 只开放可信读取和 Preview，`commit()` 固定禁用；当前真实 wx 单 bundle 的写入原子性仍标记为 `SINGLE_BUNDLE_REPLACE_UNVERIFIED`，不是已验证事务。

Phase 1E.2A 兼容接口为 `getIdentity()`、`readSnapshot()`、`getVersion()`、`getFingerprint()`、`previewCommit()`、`commit()` 和 `getCommitReceipt()`。Phase 1E.2A.1 已在受保护 Fake Gateway 的事务预演中加入持久化 revision、双 fingerprint CAS、sealed journal/backup、写后读回、恢复和有界 receipt；但真实 wx adapter 仍未开放事务 commit，也没有在微信运行时验证缺 key、容量、崩溃和跨上下文协调。普通调用方传入的 `targetKind` 或 gateway 外形不得提升为可信生产身份。

同一 `planId + idempotencyKey` 再次提交时，adapter 必须返回幂等重放引用且不重复写，不能把第一次的非空 diff 冒充本次写入。不同计划若违反业务唯一性前置条件（例如同一报价重复转订单），必须返回 `BLOCKED`，不能只依赖页面防重。

## 16. 三端适配边界

| 能力 | 共享核心 | 微信适配层 | Web 测试台 | Node 测试器 |
| --- | --- | --- | --- | --- |
| parser/route/merge/safety | 唯一实现 | 调用 | 调用 | 调用 |
| 输入采集 | 否 | 输入框、语音、剪贴板权限 | 文本/批量上传 | fixture |
| AI 网络 | 只认 adapter | `wx.request` adapter | 测试环境 HTTP adapter | fake/mock/replay/canary adapter |
| confirmation | 领域状态 | WXML 显示 | trace 面板 | 结构断言 |
| savePlan | 唯一实现 | 提交前展示/确认 | 只读展示或 MemoryStore | MemoryStore 断言 |
| 存储 | 只认 adapter | wxStorage adapter | MemoryStore | MemoryStore |
| 页面跳转 | 否 | 是 | 否 | 否 |
| 报告 | 输出结构化数据 | 可选诊断 | 可视化 | 独立报告器 |

## 17. 不变量

任何实现都必须满足：

1. `originalText` 从入口到业务记录逐字不变；
2. `LOCAL_ONLY` 的 AI 请求次数永远为 0；
3. HTTP/JSON 成功不能直接等于 AI 业务成功；
4. mock/fake/replay 不能冒充 real，当前均不得生成可提交的正式计划；
5. 请求成功与结果采用是两个状态；
6. 同一最终字段的 value、source、evidence 同步变化；
7. confirmation 不能比 finalSafety 更宽松；
8. savePlan 不能比 confirmation 更宽松；
9. commit 不能执行未通过的 formal 计划；
10. 首页与完整页对同一领域状态给出相同保存结论；
11. 失败仍返回 trace 和可安全待整理的原文；
12. mode 和 adapter 不得通过环境变量偷偷改变 parser 或安全规则。
13. source-bearing 业务记录必须逐字保存 `originalText`；客户、商品目录和纯进度/审计记录不强制复制原文。

## 18. 当前代码差距

这里的 P0/P1/P2 是“共享核心落地优先级”，不是重新打开已经修复的两个 AI 完整性 P0。

| 合同能力 | 当前是否已有 | 当前文件 | 主要差距 | 优先级 |
| --- | --- | --- | --- | --- |
| 三种 mode | 是（核心解析阶段） | `utils/record-flow-contract.js`、`utils/record-flow-core.js` | Phase 1C 已完成隔离执行；Confirmation 与 MemoryStore 计划链已具备，页面和生产 commit 尚未迁移 | P0 后续集成 |
| 不可变严格原文 | 部分 | `utils/record-flow-core.js`、`utils/record-flow-trace.js`、`utils/business.js` | 新门面/trace逐字保护；正式记录与待整理已兼容 `original_text`、`fields.originalText`；页面主流程和完整持久化合同仍未迁移 | P0 |
| 固定业务日期/时区 | 部分 | `utils/record-flow-runtime.js`、parser/safety/AI adapter、`server/src/ai/model.js` | Phase 1B 已统一共享入口、旧 hybrid 入口和 standard/deep prompt 的上海业务日期；正式保存时间及部分遗留测试仍动态取时 | P0 |
| clock/idGenerator | 部分 | `utils/record-flow-runtime.js`、`utils/record-flow-core.js`、`utils/record-flow-trace.js`、`utils/ai-parser.js`、`server/src/ai/model.js` | Phase 1B 已统一业务日期、trace clock 及 run/trace/AI request ID；monotonic deadline、parser 元数据和正式业务/存储 ID 尚未注入 | P0 |
| AI adapter | 是（核心合同） | `utils/record-flow-core.js`、`utils/record-flow-ai-adapters.js`、`utils/ai-parser.js` | Phase 1C 已统一身份、能力、请求、事件和离线 adapter；页面未接入，REAL provider 未验证 | P0 后续集成 |
| AI 空业务多层保护 | 是 | client/server AI + business | 两个 P0 已修并通过针对性 Node 动态测试；迁移时须保留 | P0 回归不变量 |
| 完整 trace | 部分 | `utils/record-flow-trace.js`、`utils/record-flow-core.js` | 已有模式、resultScope、输入/local/route/adapter/AI/merge/final/确认摘要、事件、耗时和资格；output可选返回savePlan，但trace尚未完整嵌入plan/receipt/state diff，且缺prompt hash、字段来源及完整生产脱敏策略 | P0 |
| raw/normalized AI 分层 | 部分 | `utils/record-flow-core.js`、`utils/ai-parser.js` | AI_ONLY 已独立记录 raw/parsed/normalized 且不合并；生产路径仍沿用现有标准化+合并结果，缺逐字段采用证据 | P0 |
| promptVersion/hash | 否 | `server/src/ai/model.js` | 生产 prompt 在函数内，无正式版本/哈希回传 | P1 |
| 字段来源 | 部分 | parser/AI merge | 浅合并；用户编辑、逐项商品、derived/history 不可靠 | P1 |
| 统一 confirmation | 是（领域模型） | `utils/record-confirmation-contract.js`、`utils/record-confirmation-builder.js`、`utils/record-domain-preflight.js` | Phase 1D 已统一领域安全、surface、候选、actions、revision/hash；两页只有限接入安全结论，字段展示和主解析尚未迁移 | P0 后续集成 |
| 统一保存前领域预检 | 是 | `utils/record-domain-preflight.js`、Confirmation、两页、`utils/business.js` | 客户/历史/金融/AI/mode/save gate 已统一并有副作用回归；用户编辑后重算和服务端正式部署适配尚未完成 | P0 回归不变量 |
| 确认 revision 与提交授权 | 是（MemoryStore链） | `utils/record-confirmation-builder.js`、`utils/record-save-plan-builder.js`、`utils/record-save-commit.js` | 已绑定confirmation revision/contentHash、preflight、planId/hash和state；页面真实点击授权尚未接入 | P0 后续集成 |
| savePlan | 是（未迁移生产） | `utils/record-save-plan-contract.js`、`utils/record-save-plan-builder.js` | Phase 1E.1已表达记一笔主保存与必要副作用；生产business及直接页面生命周期尚未消费 | P0 后续集成 |
| MemoryStore | 是 | `utils/record-memory-store.js`、`utils/record-save-commit.js` | 原子、回滚、幂等、失败注入已验证；微信旧Storage目前只通过只读adapter投影到MemoryStore Preview，尚无可写事务adapter | P0 后续集成 |
| Storage adapter / shadow preview | 是（只读生产边界；Fake事务预演与隔离wx测试可写） | `utils/record-storage-adapter-contract.js`、`utils/record-storage-state-projector.js`、`utils/record-storage-adapters.js`、`utils/record-storage-coordinator.js`、`utils/record-storage-transaction.js`、`utils/record-save-shadow.js`、`runtime-test/` | Phase 1E.2A.2-R1 已在独立微信开发者工具项目的四个隔离key验证revision/CAS、journal/backup、读回、跨Boot恢复、receipt、容量预检及writer队列；真机、真实业务key、跨进程存储层原子CAS和生产切换未验证，生产commit固定禁用 | P0 受控切换设计 |
| state diff | 是 | `utils/record-state-diff.js` | business/full diff已稳定；尚未进入统一五层报告和页面 | P1 |
| 自动报告 | 部分 | `scripts/release-parse-corpus-v2.js` 等 | 会生成独立报告，但 schema、版本和五层归责不统一 | P2 |
| 真实 AI canary | 部分实验 | real-ai 脚本/promptfoo | prompt 与生产可能分叉，环境/成本合同未统一 | Later |
| 微信自动化 | 否 | 人工清单 | 现有 VM 测试不等于 WXML/开发者工具运行 | Later |

## 19. 实现阶段建议

| 阶段 | 修改范围 | 主要风险 | 完成标准 | 生产影响/测试迁移 |
| --- | --- | --- | --- | --- |
| 1A. 统一状态枚举、trace 与平台无关门面 | **已实现**；新增纯合同/trace/core/adapter 模块，现有函数只做可复用阶段导出 | 页面尚未接入；trace 仍含业务内容；AI normalized 尚未分层 | 25 组专项离线测试、11 类起始 HEAD 金样本和既有 P0/核心回归通过 | 低；未改页面、分流和保存行为 |
| 1B. 注入业务 clock、businessDate、timezone 与测试 ID | **已实现本阶段范围**；共享入口、旧 hybrid 入口、parser 日期、安全、AI adapter/prompt 与 trace 已贯通 | 仅支持上海时区；parser 元数据、monotonic deadline 和业务记录 ID 留待后续 | 24 组 Phase 1B 专项及 Phase 1A/P0/route/核心/服务端离线回归通过 | 中低；未改页面和保存，服务端请求新增兼容时间字段 |
| 1C. 完成可注入 AI adapter 与三种 mode | **已实现本阶段范围**；三模式、可信 adapter、AI_ONLY 独立标准化、resultScope 和模式资格已接入共享门面 | 页面尚未接入；REAL provider 和微信运行时未验证；生产采用状态缺逐字段证据 | 16 组 Phase 1C、Phase 1A/1B、P0、route、五步用户、核心、模型和服务端 mock 回归通过 | 中；未改页面、生产 route 或保存逻辑 |
| 1D. 统一领域 confirmation 与保存前预检 | **已实现本阶段范围**；Confirmation、领域预检、domain/surface、revision/hash及两页/business有限安全接入 | 页面字段展示和主解析未迁移；用户编辑重算、savePlan绑定、真实微信运行时未验证 | 16组Confirmation、20组preflight及旧全套离线回归通过；preflight/Confirmation/完整页/首页/business五方结论/指纹与阻断零副作用已验证 | 中高；旧错误快捷放行收紧，未改布局、route或保存数据结构 |
| 1E.1. 纯 SavePlan、Commit 与 MemoryStore | **已实现本阶段范围**；共享计划、MemoryStore事务、receipt和双层diff，不切换生产business | 过渡期保存变换暂与legacy并存；直接页面生命周期不在Confirmation计划范围 | 20组专项、22个记一笔等价场景、6类失败注入、幂等/过期/金融/P0及旧全套回归通过 | 中；页面和生产business未切换 |
| 1E.2A. Storage适配与影子对照 | **已实现本阶段范围**；旧单bundle投影、可信适配器、零写入Preview、22题完整bundle影子等价和全部writer分类 | 微信写入原子性未证明；无持久化revision/CAS/读回/journal；生命周期入口多数仅分类 | 13组专项、22题Storage层等价、可信snapshot/兼容字段/零写入及旧全套回归通过 | 中；生产始终LEGACY_ONLY，共享commit禁用 |
| 1E.2A.1. 单bundle持久化协议与writer协调 | **已实现离线候选范围**；23个writer统一门面，Fake Gateway revision/CAS、sealed journal/backup、读回、恢复、有界receipt和故障矩阵通过 | 真实wx缺key/配额/崩溃/COW余量、跨上下文原子CAS、receipt淘汰后的长期金融幂等未验证；production仍LEGACY_ONLY | 22组专项、11崩溃点、16故障类、700提交receipt压力、22题三方语义等价及旧回归通过 | 高；下一步只做隔离微信运行时验证，不切换生产 |
| 1E.2A.2. 微信开发者工具隔离事务验证 | **R1已完成**；仓库外独立Mini Program先安装Storage硬白名单，再加载真实wx Gateway和跨Boot恢复Harness；生产App不注册测试页且正式打包忽略测试源码 | 真机断电、真实设备配额/落盘细节、真实用户数据迁移、跨进程原子CAS和生产切换不在本阶段 | 静态专项19/19；开发者工具15/15不重载、5类跨Boot恢复/幂等、真实业务key读写删0、forbidden 0、6个审计Boot、最终4个测试key清理为0 | 高；仅可进入受控切换方案设计，production仍LEGACY_ONLY，共享commit禁用 |
| 1E.2B.1. 共享保存受控切换控制面 | **已实现本阶段范围**；可信配置合同、受保护隔离证据、Shared资格、路径决策、阶段化回退、Recovery Lock、脱敏内存监测和隔离演练 | 无可信远程配置或在线kill switch；无客户端版本覆盖率；真实transactional Legacy writer和生产Shared路径均未实现 | 12组专项、22个Shadow基线、禁止双写、模式转换协议模拟、旧版本门禁、隐私门禁及旧全套离线回归通过 | 高；production固定LEGACY_ONLY，共享commit禁用，没有真实用户canary |
| Release A RC1. 基础设施发布候选 | **候选已实现，尚未上传**；23个Legacy writer统一经Coordinator、revision/CAS、恢复、读回、Receipt和本地脱敏监测，启动恢复先于初始化 | 必须证明活跃客户端升级覆盖和旧writer退出；没有在线kill switch；真机和真实业务key故障行为未验证 | Release A专项、22题三方业务等价、启动/恢复/CAS/旧Bundle/隐私门禁及微信隔离候选通过；production继续硬关闭Shared | 高；下一步仅可人工发布评审，不得开启Shared |
| 6. 建立第一阶段 Node 门禁 | 统一 case runner、断言、报告 | 题库只测中间对象 | 每题从原文到 state diff；零容忍 100% | 中；迁移现有 fixture，不复制 parser |
| 7. 网页测试台 | 只消费核心 output/trace | 形成第二套逻辑 | 无 parser/安全/保存复制；可看每层失败 | 低；不改变生产 |
| 8. 微信开发者工具自动化 | 页面机器人与测试账号 | 工具和登录不稳定 | 两入口输入、卡片、按钮、保存、跳转可验 | 中；独立环境 |
| 9. 真实 AI canary | REAL adapter、合成题、成本阈值 | 隐私、费用、prompt 分叉 | 版本/成本/模型/五层评分完整 | 受控；不作每次开发门禁 |
| 10. 少量真机验收 | 录音、输入法、权限、弱网、老板体验 | 自动化不能覆盖体验 | 人工清单通过且未改写技术结果 | 必须但不是核心代码门禁 |

阶段 1～6 构成第一阶段自动测试能力。每阶段都必须保持旧入口可运行，不允许一次性大改 parser、business 和页面。

## 20. 仍需老板决定

1. 复杂、低可信或冲突输入最终是否自动调用 AI，还是继续先让老板点“深度核对”。
2. “深度核对”是长期功能还是过渡措施。
3. AI 失败后，用户手工修正并明确确认所有危险字段时是否允许正式保存。
4. 客户归属、收/欠方向、金额、定金、关联订单中，哪些必须额外明确确认。
5. 第一阶段真实 AI canary 每轮允许的成本上限。

这些决定不阻断合同和确定性核心的实现；在决定前，`PRODUCTION_ROUTING` 必须保持当前规则，相关状态必须可追踪。

## 21. 共享核心实现验收

只有同时满足下列条件，才可称“共享核心 V1 已实现”：

- 微信、Web、Node 使用同一个编排入口；
- 三种 mode 符合本合同且不污染生产；
- trace 能区分本地、AI 原始、标准化、合并、确认、savePlan、commit；
- 两个页面消费同一领域 confirmation 与 savePlan；
- MemoryStore 能从原文跑到 state diff，所有组合写入可回滚；
- 两个已修 P0 和零容忍门禁保持通过；
- 没有把真实 AI 或微信真机尚未验证写成已通过。
