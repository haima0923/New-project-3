# 记一笔确认交互 V1 失败合同

这是一套失败优先的专项合同，不是生产实现。它真实加载 `pages/input/input.js`，从 PageVM 页面动作进入 production parser / safety / preflight，并从 production business 与 storage 边界记录调用。

## 证据等级

- Pure route / safety：`providerKind=UNKNOWN` 从 production normalize、final safety 和 domain preflight 进入。
- Controlled network fixture：真实 `wx.request` 调用被内存 transport 接收，可注入成功、超时、401、500、非法 JSON、空 payload 与乱序返回。
- PageVM：真实页面方法、`setData`、business/storage instrumentation 和 Fake Wx Storage。

本套件不证明 Real WXML、微信开发者工具、真机或真实线上 AI。`controlled-real-*` 仅代表运输信任边界的受控 fixture，不是真实模型成绩。

## 防假通过

- 不使用共享 Runner 的 `maybeDeepReview()`，因为它会在 `FAKE_DEEP` 下代替用户调用 `requestDeepReview()`。
- fixture 只能通过 `wx.request` callback 回到 production parser，不得访问 page 或直接 `setData`。
- AI 请求数来自 controlled transport 真实收到的事件。
- mutation 同时比对业务集合数量、production business 调用和 production storage 调用。
- 页面未实现助理问题动作时，Runner 记为合同 RED，不退化成直接编辑字段。

## 运行

```sh
node tests/record-e2e/record-confirm-interaction-v1/run.js --repeat 2
```

失败合同存在时返回码为 1，但必须同时看到：

- `CONTRACT_GATE=EXPECTED_RED`
- `DETERMINISM=STABLE`
- `RUNNER_ERROR=0`
- `GREEN_CONTROLS=PASS`

Runner 设施失败返回码为 2。

## 旧手动 Deep 合同（只读盘点）

| 文件 | 当前合同 | 与新合同的冲突 | 后续迁移 |
| --- | --- | --- | --- |
| `scripts/parse-route-observability-tests.js` | 缺金额、调价、报价转订单首轮 `PENDING`，不发 AI，点 Deep 后才请求 | 新合同要求策略命中后自动核对 | 单独迁移为“自动 Deep 仅一次，不编造、不自动保存” |
| `scripts/ai-model-routing-tests.js` | 质量模型只由主动 Deep 路由使用 | 新合同允许系统策略自动 Deep | 将可信 Deep 来源扩展到系统策略，保留简单 Local 零 AI |
| `scripts/record-shared-core-phase1a-tests.js` | 复杂 pending 保留 Deep 入口且不自动请求 | 前端手动入口不再是正确路径 | 迁移为系统核对成功或助理式单问题 |
| `scripts/core-feature-tests.js` | 多轮路由等待明确 Deep 动作 | 新合同不允许老板选择内部路由 | 保留冲突和保存阻断，替换触发条件 |
| `tests/record-e2e/runner/execute-page-observation.js` | `FAKE_DEEP` 会主动执行 `requestDeepReview()` | 会将 UX-005 伪装成自动路由 | 新套件继续绕开；旧 corpus 另行迁移 |

本轮不修改上述文件和旧 expected。
