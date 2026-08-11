# Voice Capture V2 第一台真机证据

`DIAGNOSTIC_ONLY`。本文件只冻结原生 `RecorderManager` 的真机取证，不是正式产品能力。

测试原句：

```text
冯总订水杯137个，每个5元，8月15日交
```

## TEST-A：按下后立即说

- `startCallDelay`: `0ms`
- `realReadyDelay`: `662ms`
- `pressDuration`: `6234ms`
- `reportedDuration`: `5729.857921600342ms`
- `recordedDurationDifference`: `504.1420783996582ms`
- `fileSize`: `34301 bytes`
- 原音开头实际听到：`总订水杯137个`
- 缺失：`冯`

## TEST-B：按下后等待约 1 秒再说

- `startCallDelay`: `0ms`
- `realReadyDelay`: `377ms`
- `pressDuration`: `9197ms`
- `reportedDuration`: `8978.640794754028ms`
- `recordedDurationDifference`: `218.35920524597168ms`
- `fileSize`: `53520 bytes`
- 原音开头实际听到：`冯总订水杯137个`
- 结果：完整

## 旧 POC 裁决

```text
DEVICE_RECORDER_WARMUP_REQUIRED
```

`RecorderManager.start()` 虽然在 `touchstart` 同一毫秒调用，但实际 `onStart` 存在数百毫秒
设备准备窗口。

## onStart READY 假设已被真机否定

第一台真机随后按“等 onStart 震动后再立即说”复验，仍然丢失语音开头。代表性时间线：

- `touchStartAt`: `0ms`
- `recorderStartCalledAt`: `约 +5ms`
- `recorderOnStartAt`: `约 +823ms`
- `pressDuration`: `约 6821ms`
- `reportedDuration`: `约 6163ms`
- `recordedDurationGap`: `约 658ms`
- 原音：仍缺少“冯总”开头的一部分

因此当前正式诊断裁决为：

```text
ONSTART_READY_ASSUMPTION = REJECTED
```

`onStart` 只能作为时间线 evidence，不能作为“音频首帧已经可靠进入文件”的声学权威。

## First Audio Frame Ready POC（第一台真机已完成）

### RUN-1

- `recorderOnStartAt - touchStartAt`: `252ms`
- `firstFrameAt - touchStartAt`: `492ms`
- `readyVibrationAt - touchStartAt`: `492ms`
- `pressDuration - reportedDuration`: `约94ms`
- 原音：缺“冯总”

### RUN-2

- `recorderOnStartAt - touchStartAt`: `325ms`
- `firstFrameAt - touchStartAt`: `563ms`
- `readyVibrationAt - touchStartAt`: `563ms`
- `pressDuration - reportedDuration`: `约165ms`
- 原音：同样缺“冯总”

正式裁决：

```text
FIRST_FRAME_READY = REJECTED
```

录音文件时间范围已接近真实按住时长，但首帧震动后立即讲话仍丢开头。下一实验需要区分
音频链稳定窗口与震动紧贴语音起点的干扰，不再把另一个 callback 当 READY。

## 历史 RUN-1 → RUN-2 settlement 取证

旧版诊断页只提示“上一条录音帧尚未结算”，没有保存足够的 callback trace，因此不能从
现有真机截图诚实判断是 `isLastFrame` 先到、`onStop` 先到，还是其中一个没有到达。

新版会复制 `callbackTrace`、`activeNativeSettlement`、`lastNativeSettlement` 与
`pendingTestId`。同一双终态机制现继续用于 TEST-C → TEST-D：

- `touchEnd -> Recorder.stopCalled -> terminal callbacks -> leaseSettled` 的逐项顺序：由复制证据记录
- 缺任一终态时：保持 fail-closed
- 完整结算后：自动选中已排队的下一测试，但必须由用户重新按住

## Acoustic Stabilization / Haptic Interference POC（第一台真机已完成）

### TEST-C：First Frame + NO HAPTIC

- 提示：首个有效帧后的纯视觉“现在说”，无震动
- 原音：仍缺“冯总”

### TEST-D：Third Valid Frame + HAPTIC

- 提示：第三个有效帧震动并显示“现在说”
- 原音：仍缺“冯总”

当前裁决：

```text
FIRST_FRAME_READY = REJECTED
THIRD_FRAME_READY = REJECTED
HAPTIC_INTERFERENCE_ALONE = REJECTED
NEITHER_SUFFICIENT
```

## Frame Streaming Side Effect Isolation POC（第一台真机已完成）

### TEST-E：NO_FRAME_SIZE

- Recorder options 中 `frameSize`: `ABSENT`
- `recorderOnStartAt - touchStartAt`: `约764ms`
- `diagnosticReadyAt - touchStartAt`: `约1004ms`
- `diagnosticReadyAt - recorderOnStartAt`: `约240ms`
- `firstFrameAt`: `0 / 不适用`
- 原音：缺“冯总”

### TEST-F：FRAME_SIZE_1KB

- Recorder options 中 `frameSize`: `1KB`
- `recorderOnStartAt - touchStartAt`: `约715ms`
- `diagnosticReadyAt - touchStartAt`: `约1003ms`
- `diagnosticReadyAt - recorderOnStartAt`: `约288ms`
- 原音：同样缺“冯总”

当前裁决：

```text
FRAME_STREAMING_SIDE_EFFECT = REJECTED
```

E/F 的1000ms提示实际只提供约240ms/288ms post-onStart 稳定时间。历史完整样例约有623ms
post-onStart 时间，因此下一轮直接测真实 onStart 后700ms。

## Post-onStart Stabilization / Haptic Isolation POC（第一台真机已完成）

### TEST-G：onStart + 700ms / NO HAPTIC

- Recorder options：16kHz / mono / 48kbps / MP3 / auto / 无 frameSize
- `recorderOnStartAt - touchStartAt`: `约611ms`
- `stabilizationReadyAt - recorderOnStartAt`: `约704ms`
- READY 震动：`0`
- `touchEndAt/recorderOnStopAt/duration/fileSize/tempFilePath`: `本轮用户证据未提供，不虚构`
- `recordedDurationGap`: `本轮用户证据未提供，不虚构`
- 原音是否完整包含“冯总订水杯137个”：`是`

### TEST-H：onStart + 700ms / HAPTIC

- Recorder options：与 G 完全一致、无 frameSize
- READY 震动：`1（用户从震动开始立即讲话）`
- `recorderOnStartAt - touchStartAt`: `约328ms`
- `stabilizationReadyAt - recorderOnStartAt`: `约702ms`
- `touchEndAt/recorderOnStopAt/duration/fileSize/tempFilePath`: `本轮用户证据未提供，不虚构`
- `recordedDurationGap`: `本轮用户证据未提供，不虚构`
- 原音是否完整包含“冯总订水杯137个”：`是`

当前裁决：

```text
POST_ONSTART_STABILIZATION_SUPPORTED
HAPTIC_ALLOWED
```

第二台设备覆盖状态：

```text
DEVICE_COVERAGE_MINIMUM_PASS
ANDROID_COVERAGE_PENDING
```

## 第二设备最小验收（只测正式候选 H）

```text
touchstart
  -> PREPARING / Recorder.start()
  -> 合法当前 Recorder.onStart
  -> POST_ONSTART_STABILIZING 700ms
  -> vibrateShort exactly once + “可以说了 · 松开发送”
  -> 立即说“冯总订水杯137个，每个5元，8月15日交”
  -> touchend / onStop
  -> 播放原始 MP3
```

必须记录：`touchStartAt`、`recorderOnStartAt`、`stabilizationReadyAt`、`touchEndAt`、
`duration`、`fileSize`、`tempFilePath`。

- 开头完整：`DEVICE_COVERAGE_MINIMUM_PASS`，才允许下一轮迁移正式 VCAP READY 合同。
- 仍缺开头：`DEVICE_DEPENDENT_ONSET`，停止迁移并比较该设备 onStart 与录音配置；禁止继续猜
  800/900/1000ms。

## 第二台 iPhone TEST-H（历史播放诊断 run）

已确认：

- `phase`: `AUDIO_READY`
- `lastError`: `null`
- `native lease`: `SETTLED`
- `tempFilePath`: `存在`
- `fileSize`: `37748`
- `duration`: `约6307ms`
- `recorderOnStartAt - touchStartAt`: `约136ms`
- `stabilizationReadyAt - recorderOnStartAt`: `约701ms`

旧主播放器点击后完全无声。当前裁决：

```text
POC_PLAYBACK_FAILURE
SECOND_DEVICE_AUDIO_CONTENT_NOT_YET_JUDGED
```

不能把无声播放器当作 Recorder 起音失败。修复后的诊断顺序为：

1. 重新执行一次 TEST-H 并得到 `AUDIO_READY/SETTLED`。
2. 主播放器使用 `obeyMuteSwitch=false/speakerOn=true`，观察完整 InnerAudioContext trace。
3. 仍无声时，用 `wx.playVoice` 对同一个 `tempFilePath` 做备用播放。
4. 复制 `playbackDiagnostics`，区分未发生onPlay、时间不推进、实际推进但无声或明确decoder/path错误。
5. 只有实际听过原始MP3后，才能判定第二设备是否 `DEVICE_COVERAGE_MINIMUM_PASS`。

## 第二台 iPhone TEST-H（最终验收成功 run）

同一正式候选 H：合法当前 `Recorder.onStart` 后稳定约700ms，震动到达立即说
“冯总订水杯137个，每个5元，8月15日交”，松手后播放原始MP3。

- 设备：`iPhone（第二台）`
- `recorderOnStartAt - touchStartAt`: `约170ms`
- `stabilizationReadyAt - recorderOnStartAt`: `约702ms`
- `pressDuration`: `约8756ms`
- `reportedDuration`: `约8745ms`
- `recordedDurationGap`: `约10.8ms`
- `fileSize`: `52436 bytes`
- 原音开头实际听到：`冯总订水杯137个`
- 原音完整性：`PASS`

最终设备裁决：

```text
POST_ONSTART_STABILIZATION_SUPPORTED = PASS
HAPTIC_ALLOWED = PASS
DEVICE_COVERAGE_MINIMUM_PASS = PASS
ANDROID_COVERAGE = PENDING
```

当前证据仅覆盖两台 iPhone，不能表述为跨平台完成。Android 最小覆盖不阻断本轮 READY 测试
合同迁移，但阻断最终 Voice Capture V2 候选发布。
