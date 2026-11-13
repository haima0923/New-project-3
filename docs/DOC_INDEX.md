# 货小玲项目文档索引

本文件用于新开 Codex 对话时快速建立项目上下文。Codex 应先读本文件，再根据任务读取对应文档。

> **2026-11-13 GitHub同步范围**：用户已授权把最近各轮代码、测试与修复记录提交并推送至haima0923/New-project-3的codex/windows-regression-baseline分支；默认main和线上部署保持原操作范围。
> 本次候选已备份并完成脱敏/依赖及离线回归检查。实际SHA以分支提交记录为准；历史各轮“未提交/推送”描述对应当时状态，不改写旧证据。详见 [GitHub同步范围与验证](GITHUB_SYNC_20261113.md)。

> **2026-11-13 常见交期说法已修复（本地与后台源码）**：指定年月的月底、下个月底、半个月后、几周之后、中文年月日与“号”等完整识别；“左右”、多日期及工作日时长不冒充明确自然日期。
> 主流程124/124双轮，日期保存17/17及补答/信任/解析安全回归通过；隔离微信直录十一月底、无效月份后改答下个月底、保存防重、热重载后详情/查询实际通过。未部署线上后台、更新手机包或发布。详见 [常见交期修复与验收](RECORD_COMMON_DELIVERY_DATES_FIX_20261113.md)。

> **2026-11-13 补交期与单位连续核对已修复**：“孙总定了椅子80个，289一把”补“5天之后”后，保留交期并具体核对个/把；确认后为80个×289元=23120元，不再要求重输原话。
> 主流程84/84双轮、补答/信任/安全回归通过；隔离微信首页→补答→确认→保存防重→详情→重编译→查询实际通过，原话与2026-11-18交期保留。未更新手机测试包或发布，也未调用真实AI/改服务端。详见 [补交期问题修复与验收](RECORD_RELATIVE_DELIVERY_ANSWER_FIX_20261113.md)。

> **2026-11-13 用户明确类型判断以省力为先**：根据整段内容默认最可能类型、用户可直接改；有交货/已下单依据倾向订单，明确报价格倾向报价。只有冲突或确实无从判断时才追问，不增加一律“先选类型”的步骤。
> 已撤回“手机样例默认报价本身就是缺陷”的判断，保留现有自动默认及类型切换能力；原手机证据不改写。详见 [默认类型与用户修改规则](RECORD_TYPE_DEFAULT_POLICY_20261113.md)。

> **2026-11-13 iPhone真实语音+AI已取得两条成功证据**：均为底部话筒，真实终稿、登录、qwen3.6-flash标准接口HTTP200与页面对应，500套×3.8元=1900元，客户端约2.41/1.44秒。
> 总体仍不判全部通过：首次失败未定位，首页未取得成功证据；隔离内存有1客户1报价，不能断言自动保存。默认报价按上方用户新口径复核，不作为独立缺陷。内存认证清除、测试结束；原有记录不受影响，未改生产源码/服务端或发布。详见 [真实手机验收结果](WECHAT_REAL_VOICE_AI_RESULTS_20261113.md)。

> **2026-11-12 正式语音+标准AI真机验收准备**：独立测试工程已准备，124个正式源码文件SHA一致，所有业务/认证Storage纯内存；固定测试句最多两次标准整理，测试守卫46/46通过，微信正式空首页可打开。
> 11月13日用户确认iPhone，构建与124个生产复制文件复核一致，iOS真机二维码已刷新并交手机扫码；尚未取得本轮真实手机声音和标准AI完整结果，等待真机连接。未修改生产业务代码或发布。详见 [真实语音与标准AI链路验收](VOICE_REAL_CHAIN_VALIDATION_20261112.md)。

> **2026-11-12 首页/底部语音首次连接衔接已修复**：自然普通AI核对遇登录未就绪时，在同一操作中等原连接至多5秒，准备后最多继续一次；改字、取消、离开、新录音或跨日均不能复活旧请求，确认前不保存。
> 专项32/32，原主流程72/72双轮及语音/输入信任等回归通过；微信隔离页面启动和77元本地确认卡复核完成，未新增业务记录。
> 尚未完成更新后正式手机语音加真实AI全链路，完整页自身独立话筒未扩展这项继续资格。未改API策略、parser/business/storage/配置/服务端，未发布、commit或push。详见 [首次语音登录衔接修复](VOICE_AUTH_CONTINUATION_FIX_20261112.md)。

> **2026-11-12 问一句客户范围已修复**：微信实际发现问不存在的孙总却列其他客户订单；现已明确提示未找到/需要确认，不回退全量。已知客户和全局查询实际复测通过。
> 查询边界60/60、原有查询14项、离线守卫18/18通过。77元单商品订单的确认→保存→记录/详情→查询→重编译留存在隔离微信页面通过；未涉及真实用户数据或财务流转。
> 独立手机语音已由用户确认；此前发现的首次登录时序后续修复见上方，真实正式语音完整链路仍待联调。未发布、commit、push或更新服务器，详见 [问一句客户范围修复](QUERY_CUSTOMER_SCOPE_FIX_20261112.md)。

> **2026-11-12 独立手机语音已获用户验收**：用户确认两个话筒识别准确、检查通过、上滑取消无新增文字。依据是用户手机实测反馈，未取得设备原始日志。
> 尚不代表正式语音→确认→保存→查询全流程或全部真机通过。正式页面后半程的结果以上方后续修复为准，详见 [手机语音反馈与正式页面验收](WECHAT_VOICE_ACCEPTANCE_AND_FORMAL_FLOW_20261112.md)。

> **2026-11-12 后台版本已对齐**：目标后台20文件有备份更新完成，健康与未登录保护正常；微信真实登录、空输入零模型阻断及四项整理4/4通过。
> 新业务有效标志、服务端重验和原文指纹合同已证实；服务端“三件套/三角架”回归已修复。两条复杂整理本轮约19～20秒，速度仍待优化。
> 独立语音页启动、插件初始化和手机预览二维码生成完成；其后用户手机反馈见上方。旧voice-fake合同差异保留，未宣称全量通过或上线。
> 未改生产前端App/配置，未发布小程序、commit或push。详见 [后台对齐与手机语音准备](BACKEND_ALIGNMENT_AND_VOICE_CHECK_20261112.md)。

> **2026-11-12 微信真实登录与AI联调通过（后台更新前）**：独立空数据工程中，真实微信登录HTTP200；最终四项整理检查4/4通过，两条自然AUTO_DEEP实际调用qwen3.7-plus。
> 单条AI约12～14秒；业务Storage访问及保存0，正常域名校验和运行时隔离保护有效，会话已清除。
> 该轮发现的后台业务有效标志差异已由上方后续后台对齐解决；不代表生产确认卡/保存、手机、语音或上线验收。
> 详见 [微信真实登录与AI只读联调](WECHAT_LOGIN_AI_INTEGRATION_20261112.md)。

> **2026-11-12 登录联调准备**：独立、仅登录接口的验收工程已准备，认证本地回归通过，隔离守卫12/12通过；真实登录结果仍待导入后检查。
> 三个实际语音入口当前均选择WechatSI；不应依据audioReady回调或RecorderManager测试分支要求先接文件ASR。
> 未改生产业务/配置，未调用模型或发布；详见 [微信登录联调准备](WECHAT_LOGIN_PREPARATION_20261112.md)。

> **2026-11-12 后台证书维护完成**：阿里云39.105.7.48上目标域名证书已更新并生效，有效期至2027-02-10（北京时间）。
> Windows正常HTTPS与直连目标IP校验通过，未登录智能接口返回401；该域名错误跳转已修正，专用自动续期任务已启用并实际运行验证。
> 共享站点配置、证书与Nginx主进程保持，服务器私有备份保留；未部署业务或发布小程序，真实AI、语音及手机仍待验收。
> 详见 [后台证书修复与自动续期](BACKEND_CERTIFICATE_REPAIR_20261112.md)。

> **2026-11-12 微信实际页面与补答金额修复**：已在隔离微信运行时验证输入、追问、保存、记录/详情、双击及重编译留存。
> 修复补充数量/单位后确认卡漏算金额；72项主流程双轮通过，核心120项仍为25通过/95待处理，逐题状态和业务Diff无新增变化。
> 手机、语音、真实AI尚未验收；该阶段记录的证书阻塞已由上方后续维护解决。详见 [实际页面测试与修复](WECHAT_PAGE_AMOUNT_FIX_20261112.md)。

> **2026-11-12 验收准备记录（已继续）**：本机开发者工具已打开，原模拟器有既有记录，另备隔离页面与独立存储测试工程。
> 从本机正常 TLS 校验确认后台证书已于2026-09-15过期；尚未取得健康检查或真实AI结果。
> 首页/底部话筒到录音文件后尚未接转文字；实际页面、手机及发布验收仍未完成。
> 文件夹选择已由用户完成；该准备阶段未改生产代码、配置或安全设置，后续修复结果以上方实际页面报告为准。
> 详见 [微信真机准备与上线核对](WECHAT_READINESS_CHECK_20261112.md)。

> **2026-11-11 Windows 当前结果（商品名修复）**：三角架不再误判为价格，三件套名称内部的“三件”不再作为采购数量。
> 缺数量/单价继续询问；“每套3元8月15日交”按3元保存，原文保留。
> 名称与分界专项35/35，主流程67/67双轮通过，AI原文依据保护86/86。
> 核心120题双轮仍为 `PASS=25 / CASE_FAIL=95 / RUNNER_ERROR=0`，原有25项通过、逐题状态和业务Diff保持一致。
> 未真实AI、微信渲染、真机或发布验收；下一步优先实际微信页面体验，Shared生产提交仍关闭。
> 详见 [数字商品名与数量修复](RECORD_NUMERIC_PRODUCT_FIX_20261111.md)。

> **2026-11-11 前一阶段结果**：无标点口语“卡套一千个五元一个下礼拜五交”可正确识别商品、数量、价格和交期，走本地整理。
> 识别专项34/34；主流程与边界55/55双轮通过；Runner内核79/79。
> 核心120题双轮为 `PASS=25 / CASE_FAIL=95 / RUNNER_ERROR=0`，原有24项通过保留，VOICE-006由失败转通过。
> 商品名含金额/单位词的既有误伤仍待修复；未真实AI、微信渲染、真机或发布验收，Shared生产提交仍关闭。
> 详见 [无标点口语商品识别修复](RECORD_ORAL_QUANTITY_FIX_20261111.md)。

> **2026-11-10 前一阶段结果**：常用录入指令不再混入商品或客户；否定、试探和前后冲突不直接保存。
> 识别专项 46/46；完整页、首页转交、保存/详情和待整理链路 45/45，双轮稳定。
> 逐题修订 9 条已证实的来源标记误报后，核心 120 题双轮为 `PASS=24 / CASE_FAIL=96 / RUNNER_ERROR=0`。
> 原有 15 项通过全部保留；Runner 内核 78/79，既有 VOICE-006 口语漏商品问题保留并列为下一项修复。
> 未真实 AI、微信渲染、真机或发布验收，Shared 生产提交仍关闭。
> 详见 [常用说法与来源核对](RECORD_COMMON_PHRASING_FIX_20261110.md)。

> **2026-11-10 前一阶段结果**：普通订单/报价缺客户时可逐项追问；商品回答的风险身份绑定修复；
> 待收款真实选择可完成对应确认，并保留金额、客户和最新状态保护。27 个主流程及边界场景双轮全部通过。
> 核心 120 题双轮为 `PASS=15 / CASE_FAIL=105 / RUNNER_ERROR=0 / BLOCKED=0`，5 项财务确认场景新增通过。
> Fake Provider 及其他安全门禁仍保留，Shared 生产提交继续关闭，未真实 AI、微信渲染、真机或发布验收。
> 详见 [主流程修复与验收](RECORD_MAIN_JOURNEY_FIX_20261110.md)。

> **2026-10-29 阶段记录**：已修复新保存流程中的收款日期覆盖和报价有效期默认值差异，
> 日期专项 `17/17`、新旧保存代表场景 `23` 个一致；保存内存检查 `22/22`、
> 事务恢复 `22/22`、Release A `16/16` 通过。审计清单补齐为 `24` 处写入、`21` 个生命周期。
> 核心 120 题双轮仍为 `PASS=10 / CASE_FAIL=110 / RUNNER_ERROR=0 / BLOCKED=0`，逐题状态无变化。
> Shared 生产提交继续关闭，未进行真实 AI、微信渲染、真机或发布验收。
> 详见 [日期保存修复与下一步](RECORD_SAVE_DATE_CONSISTENCY_FIX_20261029.md)。

> **2026-10-28 阶段记录**：以 GitHub `fe7e5a3` 同步到本机的源码为基线，
> 已完成 Windows 离线测试兼容修复，以及确认提示、首页转交合同和重复核对元数据修复。
> 核心 120 题两轮均为 `PASS=10 / CASE_FAIL=110 / RUNNER_ERROR=0 / BLOCKED=0`；
> 仅两条已确认的提示问题由失败变为通过，没有新增失败。保存日期默认值一致性仍未通过，
> Shared 生产提交继续关闭，未真实 AI / 微信渲染 / 真机 / 发布验收。
> 详见 [本轮修复与剩余事项](RECORD_CONFIRMATION_CONSISTENCY_FIX_20261028.md)。
> 下方候选分支说明保留为历史记录，不代表本机当前验收结果。

> 当前报价关系信任门禁候选分支：
> `fix/record-quotation-relation-trust-gate-v1`。E2E V1.2 已把
> raw parser、semantic result、proposal 和最终 outcome 分层；pending只表示最终
> disposition，不再覆盖推测业务类型。当前120题双轮为：
> `PASS=26 / CASE_FAIL=94 / RUNNER_ERROR=0 / BLOCKED=0 / SURFACE_ERROR=0`；53条P0失败全部单题重跑，
> P1分层抽查11条，23个Cluster覆盖94条失败；Hybrid/Raw parser调用图两轮一致，
> evidence missing/orphan/uncorrelated/shadow均为0。网络/真实Storage/fixture/Worker/
> 事务清理门禁均通过。`BASIC-010`的“这单”现在产生可信、未解析且不含orderId的结构化
> 订单指代Evidence，并沿raw parser、Hybrid、Confirmation和Preflight输入完整透传；
> Domain Preflight现在要求BASIC-010在真实`changeOrder()`确认合法订单前不得正式保存；
> `BASIC-009`的“那批货”不被误标为明确订单关系。日期、数量、次数、笔数、非金融“收到”与真实第二订单动作均有
> 强负例门禁。`BASIC-006`的明确报价请求现在会记录独立报价Evidence及“还没下单”的
> 订单否定Evidence，raw/semantic为quotation/create_quotation；纯“还没下单”不会
> 凭空创建报价，否定报价及“报废/报告”不会误造quotation，双重否定和后续明确下单也不会
> 被前一段否定吞掉。孤立汉字“出”现在不再提供order分数；普通“出去/出门/出差”及商业
> 非订单“报价出了吗/货款打出去了/出库”不创建订单，明确下单、订单实体和具备完整业务
> 事实的“周五出”交付简写仍保留。AMB-005现在由真实生产Route返回canonical NO_RECORD；
> FULL/HOME隐藏正式、pending和Deep入口，页面handler及business直接调用均fail closed，
> NO_RECORD正式和pending写入均为0；业务不完整、语音未完成和多轮局部结果仍保持PENDING。
> 语音最终完成现在由Provider final callback产生session绑定、sequence绑定和转写指纹绑定的
> 结构化Evidence；FULL/HOME复用同一helper并机械透传到parseHybridInput与Route输入Trace。
> partial、取消、失败、超时、旧session和手工编辑均不能保留有效final Evidence。Route现在
> 只在可信final、结构化业务Evidence充分、intent未决且无金融/冲突/Deep风险时进入一次
> AI_STANDARD。VOICE-004已从PENDING/AI0推进到AI_STANDARD/AI1；其原文没有交期，
> 测试合同现明确期待`MISSING_REQUIRED_FIELD`安全阻断、DO_NOT_SAVE、零持久化及零业务
> Diff，因此完整分层结果为PASS。`orderDeliveryDate` Expected与运行时`dueDate`由
> 测试基础设施精确别名合同比较。VOICE-006现在按Surface业务能力与生产Provider资格
> 分层：FULL_PAGE能力完整，但Fake Provider生产资格被阻断；生产写入为0，隔离提交仍
> 验证客户和订单各增加1，因此Case为PASS。VOICE-010现在使用同一分层合同：收款事实与
> 待收款选择完整、Domain和Surface业务能力为true，但Fake Deep Provider生产资格仍为
> `BLOCKED_NON_REAL_PROVIDER`，页面为`BLOCKED`且effective为false；生产写入为0，隔离
> 提交继续验证payment新增1、receivable更新1及paidAmount=2500，因此Case为PASS。
> BASIC-011现在也使用同一分层合同：真实`changeReceivable(rec-open-a)`完成待收款确认，
> Domain与FULL_PAGE业务能力均为true；Fake Deep Provider仍被生产门禁阻断，页面为
> `BLOCKED`且effective为false，生产保存调用为0。隔离提交继续验证payment新增1、
> receivable更新1、paidAmount=2500及revision/receipt各1，因此Case为PASS。BASIC-014
> 现在完成顶层parse log Envelope去重：订单加定金一次确认只写一条`save_order`日志；
> Standalone Deposit仍写一条`save_order_deposit`。Legacy与Shared SavePlan日志基数一致，
> 重放和回滚零增量，首页最近记录同一原文只出现一次。BASIC-014同时采用已审计的Fake
> Provider Surface分层合同并变为PASS；后续Surface合同修复已使SURFACE_ERROR归零，隔离
> 提交Lane总数保持88。MULTI-001、MULTI-002和MULTI-006现在冻结多商品新建订单的窄日志合同：
> 每条只创建一个包含多个`items[]`的订单，保留一条顶层`aiParseLogs/save_order`，不写
> `operationLogs`；Fake Deep Provider继续使FULL_PAGE生产资格为
> `BLOCKED_NON_REAL_PROVIDER`，页面业务能力为true但effective正式保存为false。生产保存
> 调用仍为0，隔离Legacy提交继续验证客户、订单、items、revision和receipt。三条现为PASS。
> 收款保存现在按事务绑定的待收剩余余额派生kind：未收清写`partial_payment`、正好收清写
> `final_payment`、超额拒绝；AI和调用方kind不能覆盖。Legacy、Shared SavePlan和server
> 镜像遵守同一整数分合同，定金、未关联与历史值保持兼容。FIN-001/013/014转为PASS，
> BASIC-011/VOICE-010继续PASS并强制断言`partial_payment`；全量新增的重复提交、余额分类
> 不一致和超额提交硬门禁均为0，隔离提交Lane总数仍为88。
> REL-008现在把“报价再转成订单”识别为order方向意图，现有Semantic自然得到
> create_order；“王总那个保温杯报价”产生未解析quotation关系Evidence，客户名为王总。
> 只有转换和明确quotation关系两组可信Evidence同时存在时，首次PENDING才开放用户主动
> Deep；真实`requestDeepReview()`后恰好一次AI_DEEP。本地关系贯穿Merge到Preflight，
> `quotationId`仍为空。Domain Preflight只消费结构化Evidence和最新State：已转报价
> `quo-syn-a-1`只作为`QUOTATION_ALREADY_CONVERTED`拒绝事实，安全候选为空、没有自动选择、
> 正式/pending保存和业务Diff均为0，因此REL-008为PASS。安全报价即使唯一也必须由用户真实
> `SELECT_QUOTATION`确认；AI建议、危险报价和未确认ID不能提升为可信关系。裸转换句继续
> PENDING且不开放Deep。Parser不读取State、不写quotationId。
> 当前已确认本地Parser缺陷数量为0。所有回归现在由默认离线、显式白名单且fail-closed的进程预加载门禁运行；
> Live AI smoke要求CLI和环境双重授权，最终全量统一入口控制台审计的network attempt为0。
> 网络计数与六项报价关系信任计数已进入全量JSON硬门禁。误触审计不能证明远端绝对未收到旧请求；可以确认应用未收到
> HTTP status、response headers、response body或真实AI结果，且未发现真实数据、密钥或
> 认证头被请求携带的证据。本阶段生产代码只修改`utils/record-domain-preflight.js`中的
> 报价关系信任门禁，并机械更新必要测试、Runner硬门禁和文档；没有修改Fixture、Parser、
> Route、AI Normalizer/Merge、页面、business、Storage/Coordinator核心或Provider信任政策。
> Shared生产提交仍关闭。
> 状态为 **HEADLESS NODE PAGE-METHOD RUNNER / 120-CASE DETERMINISTIC BASELINE /
> NOT WX WXML E2E / REAL QWEN NOT CALLED / NOT RELEASE**。

## 1. 新对话必读

每次新开 Codex 对话，建议先读取：

```text
AGENTS.md
docs/DOC_INDEX.md
docs/MULTI_AGENT_OPERATING_GUIDE.md
docs/CODEX_DAILY_PLAYBOOK.md
```

用途：

- 明确货小玲是什么。
- 明确不能做什么。
- 明确多 Agent 怎么协作。
- 明确不懂编程的用户如何和 Codex 协作。

## 2. 核心规则文档

| 文件 | 用途 | 谁主要使用 |
| --- | --- | --- |
| `AGENTS.md` | 项目最高规则、产品定位、高风险限制 | Codex / 所有 Agent |
| `docs/MULTI_AGENT_OPERATING_GUIDE.md` | 多 Agent 操作方法、模板、边界 | 用户 / Codex |
| `docs/AGENT_WORKFLOW.md` | Agent 角色职责和协作流程 | Codex |
| `docs/CODEX_DAILY_PLAYBOOK.md` | 日常操作手册 | 用户 |
| `docs/PRODUCT_RULES.md` | 产品定位、什么能做、什么不能做 | 产品规则 Agent |
| `docs/BUG_TEMPLATE.md` | Bug 反馈模板 | 用户 |

## 3. 代码和业务理解文档

| 文件 | 用途 |
| --- | --- |
| `docs/CODE_MAP.md` | 项目结构、页面、utils、后端、测试、高风险文件 |
| `docs/PRODUCT_AUDIT.md` | 产品定位、品牌、文案、UI 风险盘点 |
| `docs/XIAOLING_CHARACTER_GUIDE.md` | 小玲角色母版、固定特征、生成流程和验收标准 |
| `docs/RECORD_SHARED_CORE_CONTRACT.md` | 记一笔共享核心输入、模式、AI adapter、状态、trace、确认态、savePlan 和适配边界的权威合同 |
| `docs/RECORD_TEST_CONTRACT_V1.md` | 第一阶段测试题、fixture、五层评分、零容忍门禁、报告和 canary 的权威合同 |
| `docs/RECORD_E2E_CASE_CONTRACT_V1.md` | E2E Case V1.1统一Schema、固定时钟、匿名fixtures、生产观察/TEST_ONLY隔离执行、事务exact replay、State Diff和Runner消费合同 |
| `docs/RECORD_E2E_RUNNER_KERNEL_V1.md` | 独立Worker、真实页面JS方法、Surface/action注册表、Fake wx/network/voice、隔离Legacy提交、Lane、Evidence和假绿自测 |
| `docs/RECORD_E2E_FULL_CORPUS_BASELINE_V1.md` | 120题双轮确定性结果及SELECT_ORDER、报价候选真值源修订后的重基线、Ownership、当前Cluster、P0重跑和隔离门禁 |
| `docs/RECORD_SELECT_ORDER_SURFACE_V1.md` | 完整页通用订单候选、选择/取消/改选、Preflight复核、安全边界和目标Case证据 |
| `docs/RECORD_QUOTATION_CANDIDATE_SOURCE_V1.md` | Domain Preflight安全报价候选真值源、危险引用分离、REL-007/008专用Lane及后续合法picker题边界 |
| `docs/RECORD_SELECT_QUOTATION_SURFACE_V1.md` | 完整页只消费Preflight安全报价候选、选择/取消/改选、保存前复核及两条合法补充E2E题 |
| `docs/RECORD_HOME_PRIMARY_ITEM_SYNC_V1.md` | 首页单商品以items[0]为业务核心、顶层投影原子同步、金额规则、多商品保护和PAGE-008证据边界 |
| `docs/RECORD_E2E_OBSERVATION_SEMANTICS_V1.md` | Hybrid/Raw parser调用图、raw parser状态、semantic result、proposal、outcome四层合同，25条迁移和保护Case证据 |
| `docs/RECORD_PARSER_PAYMENT_INTENT_V1.md` | 明确已收款本地parser证据、待收/定金/订单/非金融负例边界及BASIC-012、PAGE-003重基线 |
| `docs/RECORD_PARSER_QUOTATION_NEGATION_V1.md` | 明确报价与订单否定的组合证据、否定范围、重新肯定保护及BASIC-006重基线 |
| `docs/RECORD_PARSER_ORDER_SIGNAL_BOUNDARY_V1.md` | 单字“出”订单误触发、短语级Evidence、商业非订单与多商品交付保护及AMB-005重基线 |
| `docs/RECORD_PARSER_QUOTATION_TO_ORDER_EVIDENCE_V1.md` | 报价转订单方向Evidence、未解析quotation关系、否定/反向边界及REL-008重基线 |
| `docs/RECORD_ROUTE_QUOTATION_DEEP_EVIDENCE_V1.md` | 双Evidence报价转换Deep资格、用户主动单次AI_DEEP、本地quotation关系Merge保留和裸句保护 |
| `docs/RECORD_QUOTATION_RELATION_TRUST_GATE_V1.md` | 明确报价转订单的用户确认信任边界、安全/危险候选分类、AI ID拒绝和REL-008零写入合同 |
| `docs/RECORD_NO_RECORD_ROUTE_POLICY_V1.md` | Clear Non-Business canonical NO_RECORD资格、页面与business持久化硬门禁、合法PENDING及异步保护 |
| `docs/RECORD_VOICE_COMPLETION_EVIDENCE_V1.md` | Provider final callback、session/转写指纹绑定、FULL/HOME机械透传及非语音渠道保护 |
| `docs/RECORD_VOICE_STANDARD_ROUTE_V1.md` | 可信语音终稿、充分业务Evidence和intent未决的窄AI_STANDARD资格、单次AI及保护边界 |
| `docs/RECORD_PARSE_LOG_ENVELOPE_POLICY_V1.md` | 顶层确认保存的解析日志Envelope所有权、订单加定金去重、Standalone保护及事务/重放边界 |
| `docs/RECORD_PAYMENT_KIND_POLICY_V1.md` | 关联待收款收款按保存时剩余余额派生partial/final、金额精度、三条保存路径及兼容边界 |
| `docs/RECORD_ORDER_REFERENCE_EVIDENCE_V1.md` | 明确订单指代的结构化Evidence、语言边界、State独立性及raw→Preflight透传合同 |
| `docs/RECORD_RECEIVABLE_ROUTE_POLICY_V1.md` | Safe Local待收款Route、复杂待收款PENDING和订单关系与Route分离政策 |
| `docs/RECORD_RECEIVABLE_ORDER_RELATION_V1.md` | 明确订单指代待收款的选择前阻断、真实选择、最新State复核和危险关系边界 |
| `docs/RECORD_OFFLINE_TEST_SAFETY_V1.md` | AI smoke误触审计、默认离线、Live双开关、进程预加载网络门禁、密钥剥离和回归白名单 |
| `docs/RECORD_WX_STORAGE_RUNTIME_TEST_PLAYBOOK.md` | Phase 1E.2A.2 微信开发者工具隔离 Storage 事务验证步骤、恢复顺序和清理规则 |
| `docs/RECORD_SHARED_SAVE_CUTOVER_PLAN.md` | Phase 1E.2B.1 共享保存受控切换、资格、回退、Recovery Lock、监测和 Release A/B/C 计划；不代表生产已开启 |
| `docs/RECORD_RELEASE_A_RC1_CHECKLIST.md` | Release A RC1 的23个Legacy writer、启动恢复、事务失败、旧Bundle升级、回滚兼容和人工发布评审清单；尚未上传或发布 |
| `docs/PARSER_AI_AUDIT.md` | 记一笔 parser / AI 链路审计 |
| `docs/BUSINESS_FLOW_AUDIT.md` | 报价、订单、待收款、收款、定金、催款业务流转 |
| `docs/TEST_AUDIT.md` | 当前测试能力、可运行脚本、缺口和回归建议 |
| `docs/CONFIG_RELEASE_AUDIT.md` | app.js、app.json、小程序发布配置风险 |
| `docs/RECORD_CONFIRM_CARD_SPEC.md` | 记一笔确认卡字段标准和多商品阶段规则 |
| `docs/RELEASE_TEST_SYSTEM_V2.md` | 当前测试证据边界、P0 状态和后续发布门禁 |
| `docs/体验版真机测试清单.md` | 体验版人工验收步骤；Node P0 已验证，但仍不能代替微信运行时发布批准 |

权威关系：

- `AGENTS.md` 是项目和产品最高规则。
- `docs/RECORD_CONFIRM_CARD_SPEC.md` 管用户可见字段和确认卡产品语义。
- `docs/RECORD_SHARED_CORE_CONTRACT.md` 管共享核心的接口和平台边界。
- `docs/RECORD_TEST_CONTRACT_V1.md` 管第一阶段自动测试、评分和报告。
- `docs/RECORD_E2E_CASE_CONTRACT_V1.md` 管 120 条核心题的机器结构和跨 Runner 复用边界；PAGE、HEADLESS、TEST_ONLY隔离提交和事务exact replay必须分lane判分。
- `docs/RECORD_E2E_RUNNER_KERNEL_V1.md` 管Headless执行内核；`docs/RECORD_E2E_FULL_CORPUS_BASELINE_V1.md`管120题双轮结果；`docs/RECORD_E2E_OBSERVATION_SEMANTICS_V1.md`管raw/semantic/proposal/outcome分层；`docs/RECORD_PARSER_PAYMENT_INTENT_V1.md`管明确已收款parser与负例边界；`docs/RECORD_PARSER_QUOTATION_NEGATION_V1.md`管报价正向Evidence、订单否定范围与重新肯定保护；`docs/RECORD_PARSER_ORDER_SIGNAL_BOUNDARY_V1.md`管单字“出”的订单信号边界与短语级Evidence；`docs/RECORD_PARSER_QUOTATION_TO_ORDER_EVIDENCE_V1.md`管报价转订单方向意图和未解析报价关系；`docs/RECORD_ROUTE_QUOTATION_DEEP_EVIDENCE_V1.md`管双Evidence Route资格、用户主动Deep和AI Merge关系保留；`docs/RECORD_QUOTATION_RELATION_TRUST_GATE_V1.md`管Preflight的安全/危险报价分类、用户确认、AI ID拒绝与零自动关联；`docs/RECORD_NO_RECORD_ROUTE_POLICY_V1.md`管Clear Non-Business canonical Route及零持久化门禁；`docs/RECORD_VOICE_COMPLETION_EVIDENCE_V1.md`管语音Provider最终回调、session/指纹绑定及FULL/HOME透传；`docs/RECORD_VOICE_STANDARD_ROUTE_V1.md`管可信终稿、充分结构化业务Evidence和intent未决的窄AI_STANDARD资格；`docs/RECORD_ORDER_REFERENCE_EVIDENCE_V1.md`管明确订单指代的parser Evidence与机械透传；`docs/RECORD_RECEIVABLE_ROUTE_POLICY_V1.md`管Safe Local待收款Route；`docs/RECORD_RECEIVABLE_ORDER_RELATION_V1.md`管明确订单指代待收款的Preflight门禁；`docs/RECORD_OFFLINE_TEST_SAFETY_V1.md`管默认离线、Live授权和进程级网络门禁；`docs/RECORD_SELECT_ORDER_SURFACE_V1.md`管完整页订单选择；`docs/RECORD_QUOTATION_CANDIDATE_SOURCE_V1.md`管安全报价候选与危险引用；`docs/RECORD_SELECT_QUOTATION_SURFACE_V1.md`管完整页报价选择；`docs/RECORD_HOME_PRIMARY_ITEM_SYNC_V1.md`管首页单商品编辑同步与保存前一致性门禁。它们都不代表WXML/DOM页面E2E或真实千问质量。
- `docs/RECORD_SHARED_SAVE_CUTOVER_PLAN.md` 管共享保存切换控制与发布顺序；它从属于共享核心安全合同，不能覆盖生产固定 `LEGACY_ONLY` 或自行批准 canary。
- `docs/RECORD_RELEASE_A_RC1_CHECKLIST.md` 管 Release A 候选证据和发布前人工检查；它不构成上传、发布或开启 Shared 的授权。
- `PARSER_AI_AUDIT.md`、`BUSINESS_FLOW_AUDIT.md`、`TEST_AUDIT.md` 是代码事实审计；
  审计中的历史结论不覆盖较新的合同和当前代码。
- 合同尚未实现。合同描述的目标能力不能写成当前已上线能力。

## 4. 后端 / 数据 / 部署文档

| 文件 | 用途 |
| --- | --- |
| `docs/api-contract.md` | API 合同说明 |
| `docs/database-schema.sql` | 数据库 schema 参考 |
| `docs/deployment.md` | 部署说明 |

这些不是多 Agent 操作核心文档，但涉及后端、数据库或部署时需要读取。

## 5. 历史测试报告

以下文件是历史报告，不是核心规则文档：

```text
docs/local-parse-safety-acceptance-report.*
docs/wechat-local-rules-evaluation.*
docs/wechat-local-rules-hard-evaluation.*
docs/wechat-local-rules-ultra-evaluation.*
```

注意：

- 历史报告不一定代表当前代码。
- 自动生成报告不进入 Git 源代码候选快照；需要时由固定提交重新生成。
- 运行相关测试脚本可能会重新生成报告文件。
- 如果本轮不希望修改报告文件，不要运行会写报告的脚本。

## 6. 按任务类型读取哪些文档

### 6.1 记一笔 / 确认卡任务

必读：

```text
AGENTS.md
docs/DOC_INDEX.md
docs/MULTI_AGENT_OPERATING_GUIDE.md
docs/RECORD_CONFIRM_CARD_SPEC.md
docs/RECORD_SHARED_CORE_CONTRACT.md
docs/RECORD_TEST_CONTRACT_V1.md
docs/RECORD_E2E_CASE_CONTRACT_V1.md
docs/RECORD_E2E_RUNNER_KERNEL_V1.md
docs/RECORD_E2E_FULL_CORPUS_BASELINE_V1.md
docs/PARSER_AI_AUDIT.md
docs/BUSINESS_FLOW_AUDIT.md
docs/TEST_AUDIT.md
docs/CODE_MAP.md
docs/RELEASE_TEST_SYSTEM_V2.md
```

重点检查：

- 输入。
- 识别。
- 确认卡。
- 保存。
- 记录页。
- 详情页。
- 问一句。
- 测试。

### 6.2 Parser / AI 识别任务

必读：

```text
docs/PARSER_AI_AUDIT.md
docs/RECORD_CONFIRM_CARD_SPEC.md
docs/RECORD_SHARED_CORE_CONTRACT.md
docs/RECORD_TEST_CONTRACT_V1.md
docs/RECORD_E2E_CASE_CONTRACT_V1.md
docs/RECORD_E2E_RUNNER_KERNEL_V1.md
docs/RECORD_E2E_FULL_CORPUS_BASELINE_V1.md
docs/TEST_AUDIT.md
docs/CODE_MAP.md
```

高风险文件：

```text
utils/parser.js
utils/ai-parser.js
utils/parse-safety.js
utils/text-normalize.js
server/
promptfoo/
scripts/
```

### 6.3 业务流转任务

必读：

```text
docs/BUSINESS_FLOW_AUDIT.md
docs/TEST_AUDIT.md
docs/CODE_MAP.md
docs/RECORD_SHARED_CORE_CONTRACT.md
docs/RECORD_TEST_CONTRACT_V1.md
```

适用问题：

- 报价转订单。
- 订单生成待收款。
- 收款核销。
- 部分收款。
- 订单定金。
- 催款提醒。
- 客户合并。

### 6.4 UI / 文案 / 页面体验任务

必读：

```text
docs/PRODUCT_RULES.md
docs/PRODUCT_AUDIT.md
docs/CODE_MAP.md
docs/RECORD_CONFIRM_CARD_SPEC.md（涉及记一笔确认卡时）
docs/RECORD_SHARED_CORE_CONTRACT.md（涉及记一笔页面判断时）
docs/RECORD_TEST_CONTRACT_V1.md（涉及记一笔页面验收时）
docs/XIAOLING_CHARACTER_GUIDE.md（涉及小玲形象时）
```

重点：

- 是否老板看得懂。
- 是否变成后台系统。
- 是否有假数据。
- 是否遗漏记录页、详情页等用户链路页面。

### 6.5 测试 / 回归任务

必读：

```text
docs/TEST_AUDIT.md
docs/CODE_MAP.md
docs/RECORD_SHARED_CORE_CONTRACT.md
docs/RECORD_TEST_CONTRACT_V1.md
```

注意：

- 旧审计用于了解当前和历史事实；新共享核心/测试实现与验收以两份合同为准。
- 部分测试会生成报告文件。
- 如果本轮不允许修改 docs/reports/temp，不要运行生成报告的脚本。

### 6.6 配置 / 发布 / 小程序权限任务

必读：

```text
docs/CONFIG_RELEASE_AUDIT.md
docs/deployment.md
```

高风险文件：

```text
app.js
app.json
project.config.json
project.private.config.json
sitemap.json
custom-tab-bar/
```

## 7. 当前重要项目快照

详细见：

```text
docs/PROJECT_CONTEXT_SNAPSHOT.md
```

该文件记录近期完成的工作、分支状态、确认卡改造边界和下一阶段建议。
