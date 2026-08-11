# Voice Capture V2 failure-first contracts

这是 `PREPARING / READY 震动 / 文件录音` 的失败优先合同，只冻结下一阶段正式行为，
不实现生产语音、不接 ASR、不进入 Input、parser、business 或 storage。

## 真机根因

第一台真机的 Independent Recorder POC 已确认：

- TEST-A 在 `touchstart` 同毫秒调用 `RecorderManager.start()`，真实 `onStart` 延迟 `662ms`；
  原音从“总订水杯137个”开始，缺“冯”。
- TEST-B 等待约 1 秒后说，真实 `onStart` 延迟 `377ms`；原音完整包含
  “冯总订水杯137个”。

当时裁决为 `DEVICE_RECORDER_WARMUP_REQUIRED`。后续第一台设备声学 POC 进一步证明：
`start()`、原生 `RecorderManager.onStart`、first frame、third frame 和 touchstart 固定1秒都不能
单独授予 READY。

第二台 iPhone TEST-H 最终验收数据：`onStartDelay≈170ms`、post-onStart稳定`≈702ms`、
`pressDuration≈8756ms`、`reportedDuration≈8745ms`、gap`≈10.8ms`、`fileSize=52436`；
实际播放原始MP3完整包含“冯总订水杯137个”。

因此正式裁决为：

```text
POST_ONSTART_STABILIZATION_SUPPORTED = PASS
HAPTIC_ALLOWED = PASS
DEVICE_COVERAGE_MINIMUM_PASS = PASS
ANDROID_COVERAGE = PENDING
```

两台设备均为 iPhone。Android 待覆盖不阻断 READY 合同迁移，但阻断最终候选发布；不得把
当前结果写成跨平台完成。

## READY 真机证据（已冻结并迁移可执行合同）

相同设备、相同16kHz/mono/48kbps/MP3/auto配置、相同原句的结果：

- TEST-G：`onStartDelay ≈ 611ms`，真实 onStart 后稳定 `≈704ms`，无震动；原始 MP3 完整
  包含“冯总订水杯137个”。
- TEST-H：`onStartDelay ≈ 328ms`，真实 onStart 后稳定 `≈702ms`，READY 震动一次；原始 MP3
  同样完整包含“冯总订水杯137个”。

裁决：

```text
POST_ONSTART_STABILIZATION_SUPPORTED
HAPTIC_ALLOWED
```

正式候选交互为：

```text
IDLE
  -> touchstart / PREPARING / Recorder.start()
  -> 合法当前 Recorder.onStart
  -> POST_ONSTART_STABILIZING（700ms，继续显示“准备中…”）
  -> READY_RECORDING / vibrateShort exactly once / “可以说了 · 松开发送”
  -> touchend / FINALIZING_AUDIO
  -> AUDIO_READY
```

700ms只能由合法当前 `Recorder.onStart` 启动。touchstart、permission、first frame、third frame
均无权启动该窗口；hide、cancel、detach、early release 或 native lease失效必须使 timer失效。

这是基于两台真实 iPhone 原始 MP3 的正式测试候选，不是凭空增加延迟。当前只迁移测试合同，
不迁移生产状态机，也不接 ASR。

## 正式 READY 测试状态机

```text
IDLE
  -> PREPARING
  -> RECORDER_STARTED
  -> POST_ONSTART_STABILIZING
  -> READY_RECORDING <-> CANCEL_PENDING
  -> FINALIZING_AUDIO
  -> AUDIO_READY
```

`TRANSCRIBING` 与 `HANDOFF` 是未来文件 ASR 阶段，本轮不得进入。

- `touchstart`：请求权限并启动原生 Recorder，显示“准备中”。
- 合法当前 `RecorderManager.onStart`：只进入 `POST_ONSTART_STABILIZING`，启动唯一700ms窗口；
  不能直接 READY 或震动。
- 700ms边界：699ms仍稳定中；累计700ms且capture/owner/native lease仍完全匹配时，才进入
  `READY_RECORDING`，震动一次并显示“可以说了 / 松开发送”。
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
| VCAP-016 | A STOP_PENDING 时拒绝重叠 B；A terminal 后用户重新发起 B，fileA 不得绑定 B |
| VCAP-017 | audio metadata 与 capture identity/时间绑定，不入 Storage |
| VCAP-018 | 260ms 不能制造 READY 或震动 |
| VCAP-019 | PREPARING UI 不能伪装“可以说了” |
| VCAP-020 | 迁移旧onStart立即READY：onStart单独无权，699ms无权，700ms READY + vibrate once |
| VCAP-021 | FINALIZING_AUDIO 文案只说处理录音，不冒充识别 |
| VCAP-022 | Recorder onError 使当前进程 POISONED；同进程拒绝复用，新进程完整恢复 |
| VCAP-023 | stop error / 缺 tempFilePath 回 IDLE，可重试 |
| VCAP-024 | 冻结两台iPhone G/H原音、700ms裁决、minimum device pass与Android pending |

## VCAP-001～024 READY迁移分类

| 分类 | ID | 裁决 |
| --- | --- | --- |
| KEEP | 001/002/003/005/006/009/011/012/014/018/019 | 原生启动、短按、权限、touch identity、owner及旧260ms零权威保持 |
| MIGRATE | 004/007/008/010/013/015/016/017/020/021/022/023/024 | 所有需要READY的正常路径显式推进合法onStart+700ms；生命周期/取消/lease/metadata安全意图不删 |
| SUPERSEDED | VCAP-020旧子语义、VCAP-024旧pending子语义 | 废止onStart立即READY/震动、设备覆盖pending；frame/touchstart/260ms亦永不成为READY权威 |

## VCAP-READY-001～012

| ID | 冻结内容 | 当前生产 |
| --- | --- | --- |
| READY-001 | touchstart/start/260ms/onStart/first/third/任意frame及onStart后699ms均不READY | RED |
| READY-002 | fake timer精确累计700ms才READY，震动一次 | RED（同时锁699ms负边界） |
| READY-003 | duplicate onStart不重启窗口，READY和震动各一次 | RED |
| READY-004 | stabilizing提前松手清timer；有效native文件仍discard | RED |
| READY-005 | stabilizing上滑取消，迟到timer与文件均无权 | RED |
| READY-006 | hide/unload/detach撤销timer，不改变Native Lease cleanup归属 | RED |
| READY-007 | POISON撤销timer；DESYNC绝不由timer取得或恢复READY权威 | RED |
| READY-008 | 已清理的stale A timer不能授权新B；绑定captureId+nativeLeaseId+generation | RED |
| READY-009 | vibrateShort抛错不撤销READY，震动attempt exactly once | PASS安全正控 |
| READY-010 | 合法700ms READY后stop once→AUDIO_READY，双身份和metadata完整 | PASS安全正控 |
| READY-011 | PREPARING/STABILIZING松手均discard并提示“请等震动后再说” | RED |
| READY-012 | Hero与Custom Tab均为699ms不READY、700ms READY | RED |

当前生产仍在onStart内立即READY，故本轮稳定为11条预期RED（迁移后的VCAP-020 + 10条新
READY差异）和28条PASS；这是真实生产缺口，不是runner失败。

## 旧 Hold 合同迁移

| 分类 | 旧合同 |
| --- | --- |
| KEEP | P0-HOLD-001/002；TAB-001/003/004/006；HOLD-004～018 中 touch identity、cancel/slide-back、lifecycle、stale final、typed/paste、owner、handoff 与唯一 Input 权威 |
| MIGRATE_TO_VCAP | TAB-002、TAB-005、HOLD-001、HOLD-002、HOLD-003 的阈值/短按/正常发送部分 |
| SUPERSEDED | ONSET-001～006 及任何“260ms 后才开始采集”“短按 Provider start=0”“controlled WechatSI final 能证明声学开头完整”的断言 |

KEEP 只表示安全意图继续成立；未来实现仍须由 VCAP 的 Recorder session 身份重验，不能直接
把旧 WechatSI 运行结果当作文件录音正控。

## Native Lease 安全合同迁移

`RecorderManager.onStart/onStop/onError` 没有 callback session identity，因此不能把
“User Capture 已结束”当作“原生 Recorder 已结算”。本轮迁移三条旧语义：

- LEASE-015：prestart early `onStop` 进入 DESYNC；late `onStart` 触发 cleanup stop，
  新 terminal 后才允许新的 C；缺失 callback 时不能靠 timer/lifecycle 猜恢复。
- VCAP-016：A `STOP_PENDING` 期间 B `Recorder.start()` 增量必须为 0；A terminal 后由
  用户重新发起 B，B 的 captureId/nativeLeaseId/fileB 必须一致，fileA 不能进入 B。
- VCAP-022：任何原生 `onError` 都隔离当前进程的 recorder epoch；timer、页面生命周期、
  owner release 和迟到 callback 均不能解除，只有全新 runtime/manager 可恢复。

这不是 production regression，也不是放宽 expected。安全模型已从“用户 capture 结束即可
复用 Recorder”升级为“Native Lease 明确结算后才可复用 Recorder”。宁可拒绝下一次录音，
也不能把旧录音文件串绑到下一笔业务。

## 证据边界

- `STATIC_WXML`：从真实 Dashboard / Custom Tab WXML 提取 touch handlers。
- `PAGE_VM / COMPONENT_VM`：真实生产 Page/Component 入口。
- `CONTROLLED_RECORDER`：手工释放 onStart/onStop/onError；不自动 final。
- `REAL_DEVICE_EVIDENCE`：VCAP-024 冻结两台iPhone已完成的原音事实，并明确Android待覆盖。

Controlled Recorder 能证明状态、身份和零业务 mutation，不能证明手机录到了第一个字。

## Runner

```sh
node tests/record-e2e/voice-capture-v2/run.js --repeat 2
```

- exit `1`：当前生产READY差异或干净父提交缺少V2 controller时的稳定预期 RED；
- exit `2`：Runner error、GREEN failure、不稳定或 baseline drift；
- exit `0`：未来生产实现全部转绿且已显式迁移 baseline。

当前未修生产的冻结结果为 `28 PASS + 11 CASE_FAIL + 0 RUNNER_ERROR`、两轮稳定、
`EXPECTED_RED`。候选 test-only commit在干净父提交缺少未提交controller时，按能力分层保持
稳定预期红而不是Runner error。未来生产实现转绿后必须另行显式迁移failure-first baseline。
