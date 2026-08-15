# 1. Git / Candidate 状态

- Branch：`fix/record-wxvoice-readiness-ux-v1`
- HEAD：`85ba4f438bbb39df56a138c931ecfa7f0b5fbe49`
- `candidate-voice-wxvoice-readiness-ux-v1`：`85ba4f438bbb39df56a138c931ecfa7f0b5fbe49`
- Candidate 与 HEAD 完全一致。
- 开始审计时工作树不干净，原有改动只在 `tests/diagnostic/voice-capture-v2-poc/`。这些 POC 改动不是 Candidate 内容，也未被本轮清理或修改。
- 本轮只新增/修改 `tests/record-e2e/**` 测试与测试说明。没有修改生产文件，没有 commit、push、tag、reset、rebase 或 checkout。

本轮是“测试可信度完整交付”，不是“记一笔生产功能完整交付”。允许范围仅为只读生产审计、测试侧观测修正、Golden Corpus、Failure Taxonomy 和冻结基线。

# 2. 当前真实链路

```text
WechatSI final result
  utils/voice-recognition.js:startVoiceRecognition
  -> { text, voiceCompletionEvidence }

首页 Hero / 底部中心话筒
  utils/hold-to-talk-controller.js:onStop
  -> publishLegacyTranscript(owner, result.text)
  -> utils/record-entry-handoff.js:publishRecordEntryHandoff
  -> wx.switchTab('/pages/input/input')

完整页接管
  pages/input/input.js:onShow
  -> consumeRecordEntryHandoff
  -> setData(text/source)
  -> runParse('standard')

理解链
  pages/input/input.js:runParse
  -> utils/ai-parser.js:parseHybridInput
  -> utils/parser.js:parseInput（本地规则事实底座）
  -> route / 可选 AI transport / guarded merge
  -> utils/parse-safety.js final safety
  -> utils/record-domain-preflight.js
  -> parse result / Draft

确认链
  pages/input/input.js:buildConfirmationState
  -> pages/input/input.wxml 确认卡
  -> 用户编辑、类型/客户/关系选择
  -> 每次重新 buildConfirmationState + safety/preflight

保存链
  pages/input/input.js:saveFormal 或 savePending
  -> utils/business.js:saveConfirmedDraft 或 savePendingNote
  -> 再次 final safety + domain preflight
  -> quotation/order/receivable/payment/deposit/todo/pending 业务对象
  -> utils/storage.js:saveState
  -> utils/record-storage-coordinator.js Release A legacy transaction
  -> CAS / backup / journal / readback
  -> utils/record-storage-gateways.js:wx.setStorageSync
  -> yiwu_boss_ai_assistant_v1
```

手写、首页粘贴与首页语音目前都先通过 handoff 切到完整页；完整页手写、粘贴、页内语音直接进入 `runParse`。首页仍保留 quick-confirm/save JavaScript，但当前 `dashboard.wxml` 没有可见确认卡或保存绑定，不是现行可达用户链。

实际生产保存 payload 是 `confirmationState.parseResult`，不是 Shared SavePlan。Shared Confirmation/SavePlan 仍主要服务共享核心和测试；不能用它的通过结果替代完整页真实保存链结论。

关键转换点：

- 粘贴输入把逐字 raw 原文与 extracted understanding text 分开；页面在解析后恢复 `original_text`，并在 paste 时保留 `raw_text`。
- 确认页把 `product_name/name`、`unit_price`、`total_amount/amount`、`deliveryDate/dueDate`、`remark` 分别归一到 item 标准字段。
- `items[0]` 会投影到旧顶层商品字段；多 item 金额齐全时汇总整单金额，明确整单总价优先。
- business 再归一 items、剥离确认页临时 key，并再次生成旧顶层兼容字段。
- 报价 `dueDate` 保存为 `deliveryDate`；订单保存为 `requiredDeliveryDate/expectedShipDate`；todo 保存为 `remindDate`；payment 当前保存为调用当天 `paidAt`。
- dunning 在“记一笔”中保存为 `todo + todoType:dunning`，不是 `dunningRecords`。
- business 的原文 fallback 只认 `parseResult.original_text -> fields.originalText -> fields.original_text`，不认顶层 `originalText` 或 `raw_text`。

# 3. Voice → Record 边界结论

Voice V1 内部可以继续冻结，但发现一个明确的 Voice→Record 合同缺口：

- WechatSI final 已生成有效 `voiceCompletionEvidence`。
- 首页/底部话筒的 controller 只把 `result.text` 交给 `publishLegacyTranscript`。
- handoff schema 只保存 `originalText/source/autoParse/originSurface`。
- 到 `pages/input/input.js:onShow` 时，页面只能重新标记为 Voice 输入，无法把同一 final session 的 completion evidence 传给 `parseHybridInput`。

因此 Record 正式接管点是 `publishRecordEntryHandoff/consumeRecordEntryHandoff`，缺口位于冻结 Voice 与 Record 的边界 schema，不在 WechatSI 或 Recorder 状态机内部。后续只需允许窄边界修复；不应借机重开 Voice V1 内部实现。

完整页页内直接语音会携带 completion evidence，没有同一缺口。

# 4. 现有测试资产复用情况

| 资产 | 本轮处理 | 结论 |
| --- | --- | --- |
| Core120 | 作为唯一主 corpus/schema/fixture/runner 骨架，引用而不复制 | Candidate 必须固定重跑；旧文档的 26/94 只是历史 seed |
| 现有 Record E2E | Q2O、单/多商品完整保存、确认交互/表面、对话、入口统一、保存 hang 等作为专项回归和 Golden 来源 | 不重复造案例；旧 expected-red 数字不继承 |
| Parser tests | payment、receivable、quotation negation、order signal/reference 作为 component canary | 可定位理解层，不能冒充五层 E2E |
| Business/Save tests | domain preflight、payment balance、Release A、Shared Core phase suites | 可定位关系/事务风险，Shared SavePlan 不能代替生产页保存 |
| AI tests | safety、model routing、offline replay 直接运行 | 未联网、未接新模型；旧 real-AI/promptfoo 仅作 seed |
| Voice tests | lease、hold-to-talk、voice-capture-v2、wxvoice-readiness | 验证 synthetic 生命周期/边界，不证明真实 ASR 质量 |

仓库没有经认证的真实 WechatSI final transcript corpus。原有 Voice POC 只含真机录音/人耳听感材料，明确不含 WechatSI、ASR、parser 或 handoff，且工作树正在修改，因此未混入 Candidate 基线。

# 5. Golden Corpus V1

- 总计：142。
- Core120：120，原样引用。
- 新增可执行 supplemental：19。
- `SPEC_REQUIRED`：3。
- `VOICE_TRANSCRIPT` 分类：21。
- 业务覆盖：order 86、quotation 12、receivable 4、payment 21、order_deposit 5、todo/dunning 6、pending 4、unknown 4。
- 表达覆盖：手写、首页 handoff、完整页、粘贴聊天、固定 voice transcript、pending edit；单/多商品、口语数字、绝对/相对日期、金额、关系引用、自我纠正、残句、聊天、混合业务、冲突和低信息。
- 负向 safety：必须逐字段断言 `mustNotInvent`、零正式副作用、关系不自动绑定和 pending/no-record 结果，不能用宽泛 expected 值放过乱猜。

新增的直接 P0 探针覆盖：报价转订单本次原话、历史收款日期、报价有效期不得自动生成、普通 todo 手机号不得造客户、零金额订单不得生成 0 元待收、原文 alias 边界、Q2O 幂等与双向关系、pending 零正式副作用。

Voice transcript 补充覆盖：`三块八/3块8`、`两万三/一万五`、`二十五号/25号`、`月底/下周三`、数量纠正、日期纠正和模糊多商品。

没有为达到 150 机械加入同义改写；142 个高价值且去重后的案例比填充低价值 paraphrase 更符合 V1 目标。

五层执行仍使用同一 case 的 lane 聚合，不创建第二套 executor：L1 Intake、L2 Understanding、L3 Confirmation、L4 Save、L5 Full E2E。

本轮测试侧还修正了三个观测盲点：runner 会真实跟随首页 `switchTab` 到完整页；Raw graph 使用 primary/fact/route/draft 角色完整性而不锁死实现调用总数；FIN-014 的前置 safety block 不再误报 Runner Error。Voice evidence 缺失现在是产品合同红，不是测试基础设施红。

# 6. Baseline 成绩

冻结报告：`/private/tmp/record-e2e-trust-readiness-v1.json`。Core 原始报告：`/private/tmp/record-e2e-trust-core120-final.json`。

| 状态 | 数量 |
| --- | ---: |
| TOTAL | 142 |
| PASS | 17 |
| EXPECTED_RED | 122 |
| UNEXPECTED_RED | 0 |
| SPEC_REQUIRED | 3 |
| RUNNER_ERROR | 0 |

两轮结果 deterministic stable。`EXPECTED_RED` 的含义是测试准确暴露当前缺陷或合同差异，不是豁免。`UNEXPECTED_RED=0` 是因为这是 Trust Readiness V1 的首次冻结，没有旧版 V1 绿签名可供比较；后续必须用本报告的 case + failure signature 比较。

按严重度：P0 为 7 PASS / 71 EXPECTED_RED；P1 为 10 PASS / 51 EXPECTED_RED / 3 SPEC_REQUIRED。

按层级：L1 13 red；L2 79 red、6 pass、3 spec；L3 21 red；L4 9 red、3 pass；L5 8 pass。

Core120 原始结果为 PASS 8 / CASE_FAIL 112 / RUNNER_ERROR 0 / BLOCKED 0。两轮 Raw parser evidence missing 为 0，真实网络请求 0，真实 wx storage 调用 0，重复 payment commit 0，超额 payment commit 0；首页 Voice completion evidence 缺失稳定为 3。

相关专项回归：

- Q2O 28/28、quotation detail convert 14/14，两轮稳定。
- confirmation interaction 19/19、confirmation surface 12/12、conversation 15/15、entry unification 19/19、save hang 9/9。
- Voice frozen relevant：lease 19/19、hold-to-talk 32/32、voice-capture-v2 39/39、wxvoice-readiness 14/14。
- single-item complete save：41 PASS / 15 CASE_FAIL；multi-item complete save：9 PASS / 1 既有 expected red；order-date-whitespace：14 PASS / 14 CASE_FAIL，另有 safety control PASS。
- payment balance 9/9；AI safety/model routing/offline smoke 全部通过。
- 旧 component/self-test 仍有 Candidate 合同漂移：domain preflight 25/28、runner self-tests 71/78、order-selection surface 首个域结论失败、Release A RC1 在 3/16 后被当前 safety 合同阻断、order-reference 的旧 expected-red 已变为 PASS。这些是现有断言/产品合同差异，不是本次 baseline 的 Runner Error。

# 7. P0 红线成绩

“合同红”包含上游失败引发的级联断言；“直接确认”要求观察到相应字段/业务状态实害。二者必须分开，避免把所有红都误称为错误落库，也避免低估直接 P0。

| 红线 | 检查案例 | 合同红 | 直接确认 |
| --- | ---: | ---: | ---: |
| originalText | 75 | 25 | 3 |
| 客户 | 71 | 26 | 1 |
| 商品/数量/单位/价格 | 67 | 33 | 1 |
| 金额 | 69 | 31 | 2 |
| 日期 | 47 | 16 | 3 |
| 重复正式保存 | 2 | 1 | 0 |
| relations | 37 | 10 | 0 |
| 虚构信息 | 74 | 56 | 5 |

解释：

- originalText 的 3 个直接观测中，2 个是粘贴聊天进入页面时全角冒号/逗号被 normalize；最终保存对象仍保留逐字原文。另 1 个是报价转订单确实把“本次转换原话”覆盖成旧报价原话，属于真实保存损失。
- 重复保存有 1 个 duplicate lane 合同红，但前置 safety 阻止了 lane 执行；没有观察到双提交。Core hard gate 的 duplicate payment commit 为 0。
- relation 有 10 个合同红，但本轮直接状态探针没有确认错误 relation 已落库；静态审计仍发现若干关系 ID 缺少统一用户确认门禁，必须纳入下一阶段。
- 直接确认的虚构事实包括：自动 `validUntil=today+7`、普通 todo 创建“临时客户”、零金额订单生成 0 元待收，以及两条模糊 voice transcript 生成无证据商品。
- Confirmation→Save 的 Core `SAVE_MAPPING` 另有 4 个合同红，不能被总通过率掩盖；其中部分受上游 draft/safety 失败影响，需在修复阶段保持逐字段读回判定。

# 8. Top Failure Clusters

按 P0/P1、共享根因、影响数和回归风险排序：

1. **保存语义与禁止造假（直接 P0）**：5 个直接业务探针稳定复现本次原话覆盖、收款日期写今天、报价自动有效期、todo 造客户、0 元待收。共同根因在 business save mapping/default policy，不是 parser 识别率。
2. **Voice→Record handoff evidence（P1 边界，3 题）**：首页 Hero/底部话筒丢 completion evidence；完整页直接语音正常。共同根因是 handoff schema，修复不应进入 Voice 内部状态机。
3. **理解 route / operation 合同漂移（69 题）**：其中 route 为首错 58 题，operation source/semantic type 为其余主要部分。它表示 Candidate 的 route/operation 与冻结 expected 不一致；多数场景被阻断或进入 pending，并非 69 次错误落库。
4. **Safety / pending policy（17 题）**：正式资格、missing/low/conflict 与 domain preflight 的共享门禁不一致；同时存在过度阻断和信息不足时仍生成事实两种方向。
5. **Confirmation 语义映射和编辑状态（约 16 个首错）**：金额 6、商品 3、关系 2、确认字段 2、数量 1、日期及业务类型切换污染。共享结构问题是页面仍使用通用 `amount/dueDate`，未消费已有 semantic confirmation builder。
6. **originalText intake 表面合同（11 题）**：8 个 P1 与 2 个 P0 是页面 text/paste normalize；最终对象仍能保留 raw，但违反“Parser 前逐字输入可观测”的严格 L1 合同。另一个 P0 是独立保存损失，归 Cluster 1。
7. **Save/transaction lane（4 Core save mapping + 1 duplicate contract red）**：没有 Runner Error，也没有确认双提交；需要在上游正式资格修复后继续验证 exact state diff、rollback、replay、restart 和 CAS。

三个 `SPEC_REQUIRED` 不进入上述产品缺陷数：

- 报价只有客户+商品时，产品确认卡规范允许正式不完整保存，但 parser/safety 要求数量和价格。
- 订单只有客户+商品时，确认卡规范、parser、safety 和旧 runner 对数量、价格、交期的 required 定义不同。
- dunning 的“客户或事项 + 提醒日期”与 parser 当前“必须客户、未要求日期”冲突。

# 9. 当前最危险的三条用户场景

1. 老板说：“把王总那张纸杯报价转成订单，20 号交。”系统能转单，但新订单的 `originalText` 取旧报价原话，不是老板这次的转换指令。以后追溯为什么转单、说了什么交期，会看到错误证据。
2. 老板说：“昨天收到王总一万五。”确认卡不显示可编辑的收款日期，最终 `paidAt` 写成今天。账确实收了，但发生日期被改写，会直接污染收款历史。
3. 老板说：“明天提醒我打 13800138000。”这本来只是个人提醒，当前保存链可能创建一个名为“临时客户”的客户。老板没有提供客户事实，系统却生成了客户数据。

同级风险还包括：“给王总报纸杯 1000 个，1 元一个”自动多出七天有效期，以及从无总额订单生成 0 元待收。

# 10. 哪些问题只是识别率不足

只是理解/覆盖不足的典型情况：口语日期没有解析、`两万三/一万五` 的语义不稳定、`不对，三千个` 自我纠正没有取最终值、模糊多商品没有可靠拆分、route 选择与冻结合同不同但最终被 safety 阻断。这些应该 pending 或显式要求确认，属于 P2/P1 改善目标。

不是“识别率不足”的问题：原话在保存映射被替换、用户日期写成今天、系统自动补有效期、无客户 todo 创建客户、0 金额创建待收、隐藏 relation/type 字段污染、确认卡值与最终对象不一致。这些即使 parser 识别率提高也不会自然消失，必须优先按 P0/P1 修共享保存/确认合同。

# 11. 下一阶段建议

1. **先修保存语义与 no-invention cluster。** 以 5 个直接 P0 探针为第一 Gate；聚焦 `utils/business.js` 的 originalText/date/default/customer/receivable mapping，并维持 state snapshot/rollback。预计直接关闭 5 个已确认探针，并为 4 个 Core SAVE_MAPPING case 解锁真实下游验证。
2. **单独修 Voice→Record handoff schema。** 只让 `voiceCompletionEvidence`、真实 entry surface/channel 随 handoff 到完整页；保持 `voice-recognition.js` 和 Recorder/WechatSI 内部冻结。直接覆盖 3 个首页 Voice boundary red。
3. **修 Confirmation semantic mapping 与类型切换清理。** 让 paymentDate、orderDeliveryDate 等业务日期真实显示/可编辑；类型切换清理旧 relation、todoType 和不适用金额字段；itemDeliveryDate/itemRemark 必须可改或明确降级 pending。
4. **统一 relation user-confirm gate。** update quotation/order、create receivable/todo 与 payment/deposit 使用同一选择确认原则；用 selection、跨客户、删除/状态漂移、双向 Q2O Golden 验收。
5. **冻结三项产品规格。** 先决定稀疏报价、稀疏订单和 dunning required fields，再把 `SPEC_REQUIRED` 转 ACTIVE。不得用当前实现反推产品答案。
6. **最后处理 route/safety/理解率大簇。** 用同一 Corpus 比较 Current Parser 与未来 AI Parser；禁止为了分数改 expected，禁止新接模型后另建标准。

生产修复必须由单一实现 Agent 串行进行；`parser.js`、`business.js`、`storage.js`、输入页和 Voice 边界都属于高风险文件。每个 cluster 修完后重跑 Core120 + supplemental 两轮，并把旧 PASS 变红或 failure signature 漂移标为 `UNEXPECTED_RED`。

尚未验证：真实 WXML/DOM 视觉、微信开发者工具、真机、真实 WechatSI final transcript、真实远端 AI、真实 wx storage。它们不阻断进入 failure-cluster 开发，但阻断发布验收。

# 12. 是否允许进入生产修复阶段

`READY_FOR_FAILURE_CLUSTER_FIX`

理由：真实链已定位，Golden Corpus 和 taxonomy 可重复运行，Core 与 supplemental 两轮稳定，`RUNNER_ERROR=0`，P0 可单独统计，失败已形成共享根因 cluster，且本轮没有修改生产行为。

这不是 `READY_FOR_RELEASE`。下一阶段只授权按上述 cluster 逐个提出并确认生产修复范围。
