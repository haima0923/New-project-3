# Voice Capture V2 failure-first contracts

这是 `PREPARING / READY 震动 / 文件录音` 的失败优先合同，只冻结下一阶段正式行为，
不实现生产语音、不接 ASR、不进入 Input、parser、business 或 storage。

## 真机根因

第一台真机的 Independent Recorder POC 已确认：

- TEST-A 在 `touchstart` 同毫秒调用 `RecorderManager.start()`，真实 `onStart` 延迟 `662ms`；
  原音从“总订水杯137个”开始，缺“冯”。
- TEST-B 等待约 1 秒后说，真实 `onStart` 延迟 `377ms`；原音完整包含
  “冯总订水杯137个”。

裁决为 `DEVICE_RECORDER_WARMUP_REQUIRED`。定时器、`start()` 已调用、旧 WechatSI
`onStart` 都不能授予 READY；只有本次原生 `RecorderManager.onStart` 可以。

第二台设备仍为 `DEVICE_COVERAGE_PENDING`。

## 状态机

```text
IDLE
  -> PREPARING
  -> READY_RECORDING <-> CANCEL_PENDING
  -> FINALIZING_AUDIO
  -> AUDIO_READY
```

`TRANSCRIBING` 与 `HANDOFF` 是未来文件 ASR 阶段，本轮不得进入。

- `touchstart`：请求权限并启动原生 Recorder，显示“准备中”。
- `RecorderManager.onStart`：唯一 READY 权威；震动一次，显示“可以说了 / 松开发送”。
- READY 前松手：丢弃本次 session；迟到回调无权；提示“请等震动后再说”。
- READY 后松手：`RecorderManager.stop()` 恰好一次，进入 `FINALIZING_AUDIO`。
- 合法 `onStop`：保留 capture 绑定的 `tempFilePath/duration/fileSize`，进入 `AUDIO_READY`。
- 第一次授权：授权成功后结束当前手势并提示重新按住；下一次触摸才开始录音。

## VCAP 矩阵

| ID | 冻结内容 |
| --- | --- |
| VCAP-001 | Hero touchstart 立即调用原生 Recorder，进入 PREPARING |
| VCAP-002 | Hero / Custom Tab immediate capture 一致，Tab 不跳 Dashboard |
| VCAP-003 | READY 前短按已 start，但必须 discard、零业务结果 |
| VCAP-004 | READY 长按 stop once 后只进入 AUDIO_READY |
| VCAP-005 | onHide 在 READY 前安全取消，迟到回调无效 |
| VCAP-006 | 首次授权必须重新按住 |
| VCAP-007 | 纯垂直上滑取消并丢弃音频 |
| VCAP-008 | 滑回后允许形成 AUDIO_READY |
| VCAP-009 | PREPARING touchcancel fail closed |
| VCAP-010 | hide/unload/detach 各阶段失效 |
| VCAP-011 | 权限拒绝零采集、零业务 |
| VCAP-012 | touch identifier / changedTouches 所有权 |
| VCAP-013 | Hero / Tab READY、配置和震动语义一致 |
| VCAP-014 | Hero / Tab 单 owner，非 owner 不终止 |
| VCAP-015 | stop/onStop 终态恰好一次 |
| VCAP-016 | 旧 capture Recorder 回调不得污染新 capture |
| VCAP-017 | audio metadata 与 capture identity/时间绑定，不入 Storage |
| VCAP-018 | 260ms 不能制造 READY 或震动 |
| VCAP-019 | PREPARING UI 不能伪装“可以说了” |
| VCAP-020 | 真实 onStart 后 READY + vibrateShort once |
| VCAP-021 | FINALIZING_AUDIO 文案只说处理录音，不冒充识别 |
| VCAP-022 | start error 回 IDLE，可重试 |
| VCAP-023 | stop error / 缺 tempFilePath 回 IDLE，可重试 |
| VCAP-024 | 冻结第一台真机 A/B 时间线、原音和 warmup 裁决 |

## 旧 Hold 合同迁移

| 分类 | 旧合同 |
| --- | --- |
| KEEP | P0-HOLD-001/002；TAB-001/003/004/006；HOLD-004～018 中 touch identity、cancel/slide-back、lifecycle、stale final、typed/paste、owner、handoff 与唯一 Input 权威 |
| MIGRATE_TO_VCAP | TAB-002、TAB-005、HOLD-001、HOLD-002、HOLD-003 的阈值/短按/正常发送部分 |
| SUPERSEDED | ONSET-001～006 及任何“260ms 后才开始采集”“短按 Provider start=0”“controlled WechatSI final 能证明声学开头完整”的断言 |

KEEP 只表示安全意图继续成立；未来实现仍须由 VCAP 的 Recorder session 身份重验，不能直接
把旧 WechatSI 运行结果当作文件录音正控。

## 证据边界

- `STATIC_WXML`：从真实 Dashboard / Custom Tab WXML 提取 touch handlers。
- `PAGE_VM / COMPONENT_VM`：真实生产 Page/Component 入口。
- `CONTROLLED_RECORDER`：手工释放 onStart/onStop/onError；不自动 final。
- `REAL_DEVICE_EVIDENCE`：VCAP-024 只冻结已完成的第一台真机原音事实。

Controlled Recorder 能证明状态、身份和零业务 mutation，不能证明手机录到了第一个字。

## Runner

```sh
node tests/record-e2e/voice-capture-v2/run.js --repeat 2
```

- exit `1`：稳定预期 RED，所有 GREEN 正控通过；
- exit `2`：Runner error、GREEN failure、不稳定或 baseline drift；
- exit `0`：未来生产实现全部转绿且已显式迁移 baseline。

当前 failure-first 基线为 `23 CASE_FAIL + 4 PASS + 0 RUNNER_ERROR`。VCAP-011 还会揭示
权限拒绝前错误震动的问题；READY 震动只能来自真实 Recorder `onStart`。
