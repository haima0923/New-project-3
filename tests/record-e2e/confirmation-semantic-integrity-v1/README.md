# Confirmation Semantic Integrity V1 — Readiness

这是一套 failure-first 的确认语义完整性专项合同，不是生产修复。

它使用：

- Controlled Draft Fixture：隔离 Confirmation，不把本套件冒充 Parser 质量测试；
- 真实 `pages/input/input.js` PageVM 方法；
- 真实 `saveConfirmedDraft` 与 `savePendingNote`；
- Fake Wx Storage 与真实 storage facade；
- `businessCallLog` 捕获的正式 save payload。

本版规模为 54 例：51 个 executable mutation/guard case + 3 个既有
`SPEC_REQUIRED`。每题至少比较下列事实层中的相关字段：

```text
controlled draft
→ confirmation fields / confirmItems / visibility
→ user edit / businessType switch
→ confirmation parseResult.fields
→ saveConfirmedDraft payload
→ persisted business object
```

本套件读取真实 WXML 绑定并通过对应 PageVM handler 触发控件事件；它仍不证明
微信开发者工具渲染、真机、真实 AI 或 Parser 准确率，
也不修改 Golden Corpus 的业务含义。

金融/改价类用户编辑会触发生产 Route 的 AI 复核政策。为了只审计
Confirmation→Business→Storage 的字段一致性，suite 在正式保存前只恢复 fixture
原本声明的 `LOCAL` route metadata，并清除由受控 Draft 重路由产生的问答 UI 状态；
该 test-only seam 仅在没有 missing/low/conflict/domain blocker 时恢复确认阶段，不改
字段、intent、operation、manual proof 或 Business preflight，也不会被报告成真实
Provider 证据。

Hidden Field Confirmation Gate V1 追加 3 例：明确输入但无确认控件的
`validUntil` / `paymentMethod` 必须进入 CONTROL_REQUIRED，而不能静默正式保存；
同时正向锁定 quotation 的客户、商品、金额、业务日期、跟进日期、备注和严格原文
仍经真实 Business 与 Fake Wx Storage 完整保存。既有 CSI-035 继续独立覆盖无原话
证据的 stale/default hidden fields。

Deposit Amount Alias Integrity V1 在既有 CSI-032 上加严新订单定金的
Confirmation→Business→Storage 断言，并追加 3 例独立订单定金合同：旧
`amount` / `paymentAmount` alias 不得覆盖用户最终确认金额、未编辑的 200 元继续保存、
未知金额不得经 alias normalization 变成 0，并锁定 raw `manual_fields` 不能冒充真实
页面确认事件。订单总额始终独立于定金金额。

Item Mutation Provenance V1 加严 CSI-022 的删除 A → 新增 B → 正式保存链，
并新增 3 例反回归：被删首项的 flattened provenance 必须失效、仍属于当前
item 的真实 conflict 必须保留、删除后没有合法商品时不得由旧 alias 生成正式记录。
Current Confirmed Item Set 是商品事实权威，root aliases 只能由当前首项派生。

Confirmation UI Completeness V1 加严 CSI-033/034，并追加 2 例：当前商品可完整
计算时，报价合计必须只读显示并随真实 item 控件事件更新；无法由商品推导时，合法
root total 使用简洁输入控件，未知值保持为空。`itemDeliveryDate` / `itemRemark`
通过 stable item identity 绑定真实 WXML 事件，逐 item 保存，删除和新增后不得串项或继承。

## 运行

```bash
node tests/record-e2e/confirmation-semantic-integrity-v1/run.js --repeat 2
node tests/record-e2e/confirmation-semantic-integrity-v1/run.js --json --repeat 2
```

状态语义：

- `PASS`：目标合同通过；
- `EXPECTED_RED`：当前 Candidate 已冻结的真实产品缺陷；
- `UNEXPECTED_RED`：新失败或已冻结失败签名漂移；
- `SPEC_REQUIRED`：稀疏报价、稀疏订单、dunning 必填等尚未决产品规则；
- `RUNNER_ERROR`：测试基础设施失败。

退出码：

- `0`：全 PASS（允许单列、未决的 `SPEC_REQUIRED`）；
- `1`：只有 EXPECTED_RED；
- `2`：存在 UNEXPECTED_RED 或 RUNNER_ERROR。
