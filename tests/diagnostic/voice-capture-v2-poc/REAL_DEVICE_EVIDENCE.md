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

## 裁决

```text
DEVICE_RECORDER_WARMUP_REQUIRED
```

`RecorderManager.start()` 虽然在 `touchstart` 同一毫秒调用，但实际 `onStart` 存在数百毫秒
设备准备窗口。正式交互必须以真实 `RecorderManager.onStart` 作为 READY 权威，并通过可见提示
和一次震动告知用户可以开始说话。定时器不能代替 `onStart`。

第二台设备覆盖状态：

```text
DEVICE_COVERAGE_PENDING
```
