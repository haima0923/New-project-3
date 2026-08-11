# Native Recorder Lease V1

这是 Voice Capture V2 的 Native Lease 安全冻结合同。它冻结 User Capture 与原生
`RecorderManager` 生命周期必须分层；本轮只迁移测试，不修改生产代码，也不接 ASR。

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
| LEASE-015 | Hero/Custom Tab 共用同一 Native Lease；prestart early-stop 必须 DESYNC，cleanup terminal 后才允许新手势 |
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
可能刚开始录音，仍不能释放；此时必须为 A 发出一次 cleanup stop，并等新的 `onStop`
terminal，才可无业务结果地释放到 `NATIVE_IDLE`，再允许 C 完整 READY/AUDIO_READY。
cleanup 期间的 `onError` 不能证明 recorder 已安全排空，必须转为当前进程 `POISONED`，
只能由新进程恢复。若 late start 或 cleanup `onStop` 永不到达，当前 API 没有可靠同步
query/reset 信号，必须保持 fail closed；不得定时猜测恢复。

`onError` 与 `stop()` throw/missing 更弱：它们无法证明底层 recorder 已真正 terminal，
所以同一进程不自动复用。用户可通过重新进入一个新小程序进程获得确定的新 manager
lifecycle；这是当前平台能力的保守限制，不是永久业务数据锁。

## LEASE-015 安全合同迁移

旧合同把“User Capture A 已取消且先收到一次 `onStop`”直接视为 native lease 已安全
结束，并立刻允许 Custom Tab B 调用第二次 `Recorder.start()`。这在 callback 没有
session identity 时不成立：A 后续仍可能迟到 `onStart`，若已创建 B，就会把 A 回调
错误投影成 B READY。

新合同要求 prestart early-stop 进入 `NATIVE_DESYNC`。A late `onStart` 只能触发一次
cleanup stop；收到新的 cleanup terminal 后才释放 A lease。随后必须由用户重新主动发起
C，C 自己的 `onStart/onStop(fileC)` 才能形成双身份绑定的 `AUDIO_READY`。若 late start
永不到达，100/500/1000ms、页面生命周期和新触摸均不能猜测恢复。

## VCAP-016 迁移

旧 VCAP-016 允许 A 的 stop 尚未结算时重叠调用 B `Recorder.start()`，与原生回调
无 session identity 的安全事实冲突。正式迁移应为：

1. A native lease 未结算时，B 手势只得到 busy/retry，Recorder start 增量为 0；
2. A 未结算期间的迟到 callback 只作用于 A lease 或被 discard；
3. A 收到可证明的 terminal 后，下一条 B 才获得新的 native lease；
4. B 的 AUDIO_READY 只能来自 B 自己的 onStop 文件。

VCAP-016 已迁移为该串行语义：A `STOP_PENDING` 期间 B start 增量为 0；A terminal
结算后，用户重新发起 B，且 B 的双身份音频只允许绑定 `fileB`。

## VCAP-022 迁移

原合同把任意 Recorder `onError` 当成可立即回到 IDLE 的普通失败。由于平台没有同步
reset 或 callback session identity，`onError` 不能证明旧 callback 已排空。新合同把当前
进程的 native recorder epoch 标为 `POISONED`：timer、hide/show、页面切换、owner release
和新触摸都不能解除；只有销毁完整 runtime、使用全新 RecorderManager/controller 的新进程
才能恢复完整 READY→AUDIO_READY。

这三项迁移不是为了让测试变绿而放宽断言。安全模型从“用户 capture 结束即可复用”升级为
“Native Lease 有可证明 terminal 后才可复用”。宁可拒绝下一次录音，也不能让旧录音文件
串绑到下一笔业务。

## 运行

```bash
node tests/record-e2e/native-recorder-lease-v1/run.js --repeat 2
```

产品断言差异为 `CASE_FAIL`，fixture/VM/执行器异常为 `RUNNER_ERROR`。当前 V2 工作树
目标为 19/19 PASS；干净父提交缺少未提交 controller 时，能力分层保持稳定预期红且
`RUNNER_ERROR=0`。任何 Runner 错误、不稳定或基线漂移均为 harness failure。
