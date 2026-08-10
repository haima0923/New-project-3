# Voice Capture V2 — Independent Recorder Onset POC

`DIAGNOSTIC_ONLY`。这是一个与货小玲正式小程序隔离的原生微信小程序工程，只验证
`wx.getRecorderManager()` 生成的原始录音是否保留语音开头。

它不会调用 WechatSI、ASR、parser、handoff、Input、business 或 storage。

## 真机步骤

1. 用微信开发者工具单独打开本目录。
2. 先点“预先授权麦克风”，避免权限弹窗污染启动时间。
3. 选择 `TEST-A 立即说`，手指按下录音区后立刻说：
   `冯总订水杯137个，每个5元，8月15日交`
4. 松手后播放 TEST-A 原音，判断是否完整听到“冯总订水杯137个”。
5. 选择 `TEST-B 等1秒再说`，按下后等约1秒，再说完全相同一句。
6. 播放 TEST-B 原音。
7. 点“复制两条证据”，保留两条真实时间线。

不要把本目录合并进正式小程序包；取证完成后可整体删除。

已完成的第一台真机结果见 `REAL_DEVICE_EVIDENCE.md`。当前裁决为
`DEVICE_RECORDER_WARMUP_REQUIRED`，不能把 `RecorderManager.start()` 调用完成
误当成麦克风已经可靠采集声音。
