# Native Recorder Lease V1

这是 Voice Capture V2 的失败优先安全合同。它冻结 User Capture 与原生
`RecorderManager` 生命周期必须分层，不修改生产代码、不接 ASR，也不修改 VCAP
正式 expected。

## 核心原则

- `activeNativeLease <= 1`。
- User Capture discard 不等于 Native Lease 已结算。
- `onStart/onStop/onError` 不能仅通过“当前 active capture”猜归属。
- `AUDIO_READY` 必须同时满足有效 User Capture 与匹配 Native Lease。
- 归属不明时 fail closed，绝不能把 A 文件标成 B。

## 平台可观测边界

`wx.getRecorderManager()` 是进程级单例；`onStart/onStop/onError` payload 没有可用于
归属的 capture/session/lease id。测试因此只冻结 API 能证明的安全语义：

- A lease 尚未 terminal 时，B 绝不能调用第二次 `Recorder.start()`；
- 同一 start 的正常 callback 顺序只结算一次；
- `onStop-before-onStart` 等异常顺序进入 `NATIVE_DESYNC`；迟到 `onStart` 必须触发
  cleanup stop，并再观察一个 terminal callback 后才允许恢复；
- `onError`、`stop()` 抛错或 `stop` 不可用时，没有可靠 native terminal 信号，当前
  小程序进程的 recorder epoch 必须 fail closed。新的小程序进程可建立全新 manager
  生命周期；不能用猜测的 100/500ms timer 自动解除隔离。
- recorder epoch poison 不属于某个页面 owner：`hide/show`、Custom Tab detach/attach、
  释放产生异常的 Hero owner、迟到 start/stop/error 或时间推进，都不能在同一进程解除。
  poison 也不得写入业务或本地 Storage；新进程使用全新 manager 后必须能完整录音。

合同不要求生产在 A 已完整结算、B 已启动以后区分“平台任意重放的 A callback”和
“同形的 B callback”。没有原生 identity 时这不可观测，也不能由本地 `nativeLeaseId`
伪造证明。平台若真实违反一次 start 对应一组有序、终态后不重放的基本保证，只能把
它视为 native protocol failure 并停止同进程复用。

## 合同矩阵

| ID | 冻结语义 |
| --- | --- |
| LEASE-001 | 正常 A start/onStart/stop/onStop 后 B 才可开始 |
| LEASE-002 | onStart 前释放仍保留 A lease，迟到 start 仅清理 A |
| LEASE-003 | A 尚未结算时 B 不存在；A late onStart 只能清理 A，terminal 后 B 才开始 |
| LEASE-004 | A 文件绝不能绑定 B AUDIO_READY |
| LEASE-005 | A native lifecycle 未结算时 B start=0 |
| LEASE-006 | 同一 lease 的重复 start/stop callback 只结算一次，之后 B 正常完成 |
| LEASE-007 | onStop-before-onStart 进入 fail-closed，不永久 PREPARING |
| LEASE-008 | early stop 进入 DESYNC；late start 后 cleanup stop+terminal，再让 C 完成 |
| LEASE-009 | onError 污染当前 native epoch；同进程拒绝 B，新进程可完整恢复 |
| LEASE-010 | hide/detach 失效 User Capture，不释放 A native 归属 |
| LEASE-011 | owner、captureId、nativeLeaseId 三层身份独立 |
| LEASE-012 | AUDIO_READY 要求 User + Native 双身份一致 |
| LEASE-013 | B 意图不得偷换 A lease 的 capture 归属 |
| LEASE-014 | callback 静态上必须先归因 Native Lease |
| LEASE-015 | Hero/Custom Tab 共用同一 Native Lease |
| LEASE-016 | pending stale start、stop throw/missing、callback/WXML harness 威胁矩阵 |

`GREEN-LEASE-001～003` 是不依赖未提交 controller 能力的 harness 正控：分别证明
start/stop/error callback snapshot 可控、真实 Hero/Tab WXML handler 存在，以及
音频 metadata fixture 对 path/duration/fileSize 有区分力。候选 test-only commit 在
干净父 HEAD 上仍应是 `RUNNER_ERROR=0`、稳定预期红，而不是被 capability gate 全部短路。

### LEASE-003 合同修正

附件最初要求 A 已 settle、B 已开始后仍识别任意“旧 A onStart”。只绑定一次全局
callback 且 payload 无 identity 时，这与 B 自己的 onStart 不可区分。可信冻结改为更强
且可实现的边界：A 未 settle 时 B 根本不得取得 native lease；A late onStart 仍归 A，
A terminal 后才创建 B。这样关闭串绑，而不是要求生产猜 callback 来源。

### onStop-before-onStart 恢复

`onStop` 先到时不能清 lease 后继续留在 PREPARING。应进入显式 `NATIVE_DESYNC`，
discard 文件并保留 A 归属。若随后观察到 A 的迟到 `onStart`，最后一个原生事实是底层
可能刚开始录音，仍不能释放；此时必须为 A 发出一次 cleanup stop，并等新的
`onStop/onError` terminal，才可无业务结果地释放到 `NATIVE_IDLE`，再允许 C 完整
READY/AUDIO_READY。若 late start 或 cleanup terminal 永不到达，当前 API 没有可靠同步
query/reset 信号，必须保持 fail closed；不得定时猜测恢复。

`onError` 与 `stop()` throw/missing 更弱：它们无法证明底层 recorder 已真正 terminal，
所以同一进程不自动复用。用户可通过重新进入一个新小程序进程获得确定的新 manager
lifecycle；这是当前平台能力的保守限制，不是永久业务数据锁。

## VCAP-016 迁移方案

旧 VCAP-016 允许 A 的 stop 尚未结算时重叠调用 B `Recorder.start()`，与原生回调
无 session identity 的安全事实冲突。正式迁移应为：

1. A native lease 未结算时，B 手势只得到 busy/retry，Recorder start 增量为 0；
2. A 未结算期间的迟到 callback 只作用于 A lease 或被 discard；
3. A 收到可证明的 terminal 后，下一条 B 才获得新的 native lease；
4. B 的 AUDIO_READY 只能来自 B 自己的 onStop 文件。

本提交只冻结新合同，不修改 VCAP-016 expected。生产修复与 VCAP 迁移必须另轮完成。

## 运行

```bash
node tests/record-e2e/native-recorder-lease-v1/run.js --repeat 2
```

产品断言差异为 `CASE_FAIL`，fixture/VM/执行器异常为 `RUNNER_ERROR`。稳定预期红为
`EXPECTED_RED`；任何 Runner 错误、不稳定或基线漂移均为 harness failure。
