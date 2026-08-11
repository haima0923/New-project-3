# 微信语音 Readiness UX V1 — failure-first contract

本目录冻结 Dashboard Hero 与 Custom Tab 的共同目标：继续使用现有
WechatSI `RecordRecognitionManager`，但只有合法当前 Provider `onStart` 后再经过
700ms 稳定窗口，才通过一次震动授权用户开口。它是失败优先测试，不是生产实现，
也不引入文件 ASR、音频上传或新的业务权限。

## 当前真实链路审计

WechatSI adapter 位于 `utils/voice-recognition.js`：

```text
startVoiceRecognition
→ requirePlugin('WechatSI').getRecordRecognitionManager()
→ manager.start({ duration, lang })
→ session-bound manager.onStart
→ manager.onRecognize (partial only)
→ manager.onStop(res)
→ res.result accepted once
→ completion evidence + onResult({ text })
```

`onStart` 会检查 `providerBoundSession === session`、当前 session 与非终态；旧 session
只会被忽略/终止。`onStop` 在 Provider 已启动、sequence 合法、session 当前且非终态时，
才把非空 final 接受一次；重复、旧 session、取消、失败和超时后的 final 均无权。

WechatSI 原始 `onStop` payload 可包含 `tempFilePath` 等 Provider 字段，但当前 adapter
只读取 final 文本并生成 completion evidence；`onStop` handler 只收到 provider、sessionId、
status，`onResult` 收到 text 与 evidence。业务链没有保存或传播 tempFilePath。

Shared controller 已有的 legacy transcript 闭环是：

```text
startLegacyForCapture
→ voice-recognition onResult
→ exact four-key R1B handoff
→ switchTab('/pages/input/input')
→ Input consume once / runParse once / Conversation
```

四字段固定为：

```text
autoParse=true
originSurface=HOME_QUICK
originalText=<WechatSI exact final>
source=voice
```

但是当前真实 Hero/Tab WXML `touchstart` 进入 `beginHold()` 后，正式微信运行时选择的是
RecorderManager V2，只到 `AUDIO_READY`；WechatSI 分支目前只供 Node headless compatibility，
`beginHoldImmediately()` 也是无 WXML 绑定的 DEAD_COMPAT。因此“Hero/Tab 已在正式微信环境
使用 WechatSI 闭环”不成立，这是下一轮生产实现需要切换的能力，而不是本测试伪装出的现状。

## 可复用与必须修改的边界

可以复用：

- owner token、initiating touch identity 与 Hero/Tab 互斥；
- 纯垂直上滑取消、touchend/touchcancel、hide/unload/detach；
- typed/paste 淘汰旧 capture；
- WechatSI session、Provider lease、final exactly-once 与 stale final gate；
- exact R1B handoff 与 Input 唯一 Conversation authority。

不能原样复用：

- `startLegacyForCapture.onStart` 当前立即 READY、立即震动，没有700ms稳定窗口；
- legacy 分支没有 session/capture/owner/generation 绑定的 readiness timer；
- 准备态上滑后滑回当前不会恢复 PREPARING；
- WXML/WXSS 没有 `voice-readiness-fill` 注水节点和700ms自底向上动画；
- 当前 READY 文案是“可以说了”，目标是“我在听 · 松开发送”。

## Runner 证据边界

测试从真实 Dashboard/Custom Tab WXML 提取 `touchstart/move/end/cancel` handler，加载生产
PageVM/ComponentVM，共用受控虚拟时钟，并运行真实 `utils/voice-recognition.js`。受控
WechatSI manager只手工发 onStart/partial/final/error，不自动 final；测试不直接调用
`beginHoldImmediately` 或 `startVoiceRecognition`。

这是 `STATIC_WXML + HEADLESS PageVM`，不是微信真机 WXML/动画渲染。注水视觉合同只冻结：

- Hero 与 Tab 均有 `voice-readiness-fill` hook；
- WXSS 从底部填充且时长700ms；
- `animationend` 不得成为 READY 权威。

700ms 产品权限由 controller timer 决定，动画只负责视觉。测试的 cleared timer 会在真实
dueAt 再被强制重放，并同时锁 capture/session/owner/generation，防止 A timer 授权 B。

## 失败优先基线

当前生产基线：

| ID | 现状 | 首个冻结差异 |
| --- | --- | --- |
| WXVOICE-READY-001 | PASS | touchstart 立即 PREPARING |
| WXVOICE-READY-002 | PASS | Provider onStart 前即使经过2000ms也不进入 READY |
| WXVOICE-READY-003 | EXPECTED_RED | onStart 当前立即 READY，未进入700ms STABILIZING |
| WXVOICE-READY-004 | EXPECTED_RED | Hero/Tab 尚无注水 WXML/WXSS hook |
| WXVOICE-READY-005 | EXPECTED_RED | onStart 后300ms松手当前仍会采用 final |
| WXVOICE-READY-006 | EXPECTED_RED | PREPARING 上滑后滑回未恢复原阶段 |
| WXVOICE-READY-007 | PASS | READY 上滑取消、滑回、再次取消安全 |
| WXVOICE-READY-008 | EXPECTED_RED | WechatSI legacy 分支没有 readiness timer 可由 lifecycle 撤销 |
| WXVOICE-READY-009 | EXPECTED_RED | 没有可绑定/撤销/重放的 A readiness timer |
| WXVOICE-READY-010 | PASS | A stale final 不能进入 B，B final 唯一采用 |
| WXVOICE-READY-011 | PASS | WechatSI final once → R1B handoff once → Input parse once |
| WXVOICE-READY-012 | EXPECTED_RED | Hero/Tab 均在699ms前错误进入 READY |
| WXVOICE-READY-013 | PASS | 涉及链路无 external ASR caller，uploadFile=0 |
| WXVOICE-READY-014 | PASS | Provider evidence fingerprint → handoff → Input → 查看原话逐字一致 |

预期汇总：`PASS=7 / CASE_FAIL=7 / RUNNER_ERROR=0 / DETERMINISM=STABLE / EXPECTED_RED`。

## 下一轮最小生产候选

预计只需：

```text
utils/hold-to-talk-controller.js
pages/dashboard/dashboard.wxml
pages/dashboard/dashboard.wxss
custom-tab-bar/index.wxml
custom-tab-bar/index.wxss
```

controller负责把正式 Hero/Tab capture 连接到 WechatSI，并新增 provider-onStart 后700ms
session-bound timer；WXML/WXSS负责准备/注水/监听视觉。现有 JS projection 已透传 phase、
mode、title、subtitle、gesture，若实现无需新增投影字段，则 Dashboard/Tab JS 不必改。

明确禁止顺带修改：`pages/input/**`、`record-entry-handoff.js`、parser、AI、business、
storage、server、`utils/transcribe.js` 与 `utils/voice-recognition.js`。只有审计证明现有
WechatSI adapter 无法提供 session-bound onStart/final 时，才应先停止并另行申请范围。

## 运行

```text
node tests/record-e2e/wxvoice-readiness-v1/run.js --repeat 2
```

产品差异为 exit 1；runner/fixture/不稳定/基线漂移为 exit 2。生产修复后7条 RED 转绿会
先表现为 baseline drift，需在独立测试冻结轮迁移 expected，不能在生产轮改断言迎合。
