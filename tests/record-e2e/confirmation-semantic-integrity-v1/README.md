# Confirmation Semantic Integrity V1 — Readiness

这是一套 failure-first 的确认语义完整性专项合同，不是生产修复。

它使用：

- Controlled Draft Fixture：隔离 Confirmation，不把本套件冒充 Parser 质量测试；
- 真实 `pages/input/input.js` PageVM 方法；
- 真实 `saveConfirmedDraft` 与 `savePendingNote`；
- Fake Wx Storage 与真实 storage facade；
- `businessCallLog` 捕获的正式 save payload。

本版规模为 42 例：39 个 executable mutation/guard case + 3 个既有
`SPEC_REQUIRED`。每题至少比较下列事实层中的相关字段：

```text
controlled draft
→ confirmation fields / confirmItems / visibility
→ user edit / businessType switch
→ confirmation parseResult.fields
→ saveConfirmedDraft payload
→ persisted business object
```

本套件明确不证明 Real WXML、微信开发者工具、真机、真实 AI 或 Parser 准确率，
也不修改 Golden Corpus 的业务含义。

金融/改价类用户编辑会触发生产 Route 的 AI 复核政策。为了只审计
Confirmation→Business→Storage 的字段一致性，suite 在正式保存前只恢复 fixture
原本声明的 `LOCAL` route metadata，并清除由受控 Draft 重路由产生的问答 UI 状态；
该 test-only seam 仅在没有 missing/low/conflict/domain blocker 时恢复确认阶段，不改
字段、intent、operation、manual proof 或 Business preflight，也不会被报告成真实
Provider 证据。

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
