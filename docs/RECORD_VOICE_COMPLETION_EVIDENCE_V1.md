# Voice Transcription Completion Evidence V1

## 1. 目标与边界

本合同只证明一次语音识别已经由Provider最终回调完整结束，并把该事实作为结构化
source context传入Parser和Route输入审计。它不判断业务类型，不改变Route，也不触发AI。

目标链路：

```text
Provider final callback
→ active session校验
→ transcript绑定Evidence
→ FULL/HOME runParse
→ parseHybridInput source context
→ parse_route输入Trace
```

本阶段`REC-E2E-VOICE-004`仍为`PENDING / AIRequestCount=0`。下一阶段才允许Route消费
本Evidence判断是否进入`AI_STANDARD`。

## 2. Provider回调合同

当前微信语音Provider合同为：

- `onRecognize`：中间结果，只产生`PARTIAL`状态，不触发最终Parser；
- `onStop`：最终回调，只有回调自身携带非空最终文本时才可完成session；
- `onError`：终止为`FAILED`，之后到达的final无效；
- 页面取消：终止为`CANCELLED`，之后到达的final无效；
- 超时：终止为`TIMED_OUT`，已有partial不能冒充final；
- 新录音开始：旧session变为`SUPERSEDED`，旧回调不能覆盖新输入。

重复final幂等；同一session不能接受两个不同最终文本。实现不使用文本长度、延时、防抖
或Runner事后`asyncWorkCompleted`推断完成。

## 3. Evidence Schema

生产Evidence使用`voiceCompletionEvidence`：

```text
version
status
isFinal
source
provider
sessionId
utteranceId
resultSequence
callbackName
startedAt
completedAt
transcriptFingerprint
transcriptLength
transcriptSourceField
evidenceSource
```

成功Evidence固定满足：

```text
version = voice-completion-evidence-v1
status = COMPLETED
isFinal = true
source = VOICE_TRANSCRIPT
callbackName = onStop
resolved transcript fingerprint = parseHybridInput收到文本的同一指纹
```

真实Provider使用`VOICE_PROVIDER_FINAL_CALLBACK`；Fake Voice测试诚实标记
`FAKE_VOICE_FINAL_CALLBACK`。Evidence不携带Provider原始对象或完整State。

## 4. Session与指纹

每次开始录音创建新的单调session ID。Evidence必须同时绑定：

- 当前仍活跃的session；
- 当前session唯一可接受的final sequence；
- 最终传给`runParse()`的准确文本；
- 以`voice-transcript-v1`域隔离规则生成的稳定指纹。

用户在final后手工修改文字时，旧Evidence立即失效，输入回到普通手工文本渠道。空文本、
缺session、未知callback来源、sequence倒退、旧session延迟回调或指纹不一致均不能产生
有效final Evidence。

WechatSI复用单例Manager，因此Provider生命周期必须串行：新逻辑session会立即使旧
Evidence失效，但新Provider录音必须等待旧Provider的`onStop/onError`终态释放后才启动。
旧final只用于释放旧Provider lease，不能签成新session Evidence。timeout先原子进入
`TIMED_OUT`并失效绑定，再调用Provider stop；即使stop同步触发final也不能改写终态。

## 5. FULL与HOME透传

FULL_PAGE与HOME_QUICK使用同一个`utils/voice-recognition.js`会话和校验合同：

```text
FULL  onResult → runParse(text, sourceContext) → parseHybridInput
HOME  onResult → runQuickParse(text, sourceContext) → parseHybridInput
```

`sourceContext`只机械携带：

```text
inputChannel
entrySurface
voiceCompletionEvidence
```

页面不重新生成Evidence；`parseHybridInput()`只验证并把`present/status/source/valid`
四个必要脱敏状态投影到既有Route Trace。该最小Trace可能按现有`aiParseLogs`合同持久化，
但完整Evidence、session ID、转写指纹、Provider对象和原始回调Payload不得进入业务记录
或Storage。非语音渠道，包括手工、粘贴、剪贴板聊天、pending编辑和历史编辑，均不得
携带或投影Voice Completion Evidence。

## 6. VOICE-004与VOICE-006

`VOICE-004`准确转写：

```text
赵姐礼品盒五百套三块八一套
```

离线Fake链真实触发1次final和1次partial，Evidence为`COMPLETED`，session、sequence和
文本指纹校验通过；`parseHybridInput`只调用1次并收到同一Evidence。既有字段继续为客户
赵姐、商品礼品盒、数量500、单价3.8、金额1900，raw仍为`unknown/null`。

本阶段没有修改Route，因此结果继续为`PENDING / AIRequestCount=0 / ROUTE_ERROR`。

`VOICE-006`继续保留既有`AI_STANDARD / AIRequestCount=1 / SURFACE_ERROR`，没有使用
Runner事后状态补造Evidence，也没有隐藏其独立异步/Surface问题。

## 7. 隔离与冻结结果

120题离线双轮均为：

```text
ACTIVE         120
PASS            14
CASE_FAIL      106
RUNNER_ERROR     0
BLOCKED          0
```

两轮确定性一致；63条P0失败全部单题重跑，P1分层抽查13条。每轮新增硬门禁均为0：

```text
voiceEvidenceMissingCount
voiceFingerprintMismatchCount
voiceStaleSessionAcceptedCount
```

真实网络、network guard attempt、真实Storage、fixture mutation、跨Case泄漏、
Journal/Backup、Parser Evidence缺失及orphan/uncorrelated/shadow调用也全部为0。
本轮未使用真实麦克风、真实AI或真实微信Storage，未修改Route、Parser、AI Normalizer、
Preflight、business、Storage或核心业务Expected。
