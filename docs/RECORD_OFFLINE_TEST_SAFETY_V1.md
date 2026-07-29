# Record Offline Test Safety V1

## 1. 网络误触审计

2026-07-29 的 Payment Intent Parser 回归批次在工作目录
`/Users/haima/Downloads/New project 5` 中误执行了：

```text
/Users/haima/.real/.bin/node/bin/node scripts/ai-contract-smoke.js
```

该命令位于一个 `set -e` 的顺序回归批次中；Node 版本为 `v22.19.0`。终端证据只保留
`fetch failed`，没有结构化 `cause`，因此精确时分秒和 DNS/TCP/TLS 子阶段都无法从现有
证据恢复。事故日期可确认，精确执行时刻不作推测。

旧脚本在 `API_BASE_URL` 未设置时默认使用
`https://api.baizeji.com`。第一次请求按代码顺序为：

```text
POST https://api.baizeji.com/api/ai/parse
content-type: application/json
```

请求没有 `Authorization`、Cookie 或 credentials。Body 是脚本源码内固定的合成客户、
报价、订单和测试句子；脚本不读取微信 Storage、工作区业务 State、真实聊天或文件。
当前进程环境中 `API_BASE_URL`、AI/Qwen/OpenAI/DashScope key、Authorization、Cookie
和代理变量均不存在；旧脚本自身也只读取 `API_BASE_URL`，不读取任何 key。

旧脚本无显式 timeout 和 retry。测试按顺序最多发出 11 次 parse 和 1 次 query；首个
awaited fetch 抛错后进入顶层 catch，后续请求不会执行。只读进程检查未发现残留
`ai-contract-smoke`、Runner 或 baizeji 进程；工作区未生成网络报告、响应文件、密钥或
敏感文件。

事故证据边界为：

```text
failureStage                    = UNKNOWN_NETWORK_FAILURE
HTTP status received            = false
response headers received       = false
response body received          = false
real AI result received         = false
remoteReceipt                   = UNCONFIRMED
remote side effect absent       = UNCONFIRMED
```

`fetch failed`不能证明请求绝对没有离开本机，也不能排除网关访问日志；因此不得写成
“绝对零外网连接”。但没有真实用户/业务数据、密钥、认证头、响应Body或业务写接口证据，
也没有真实AI结果被测试使用。

## 2. AI contract smoke 模式

`scripts/ai-contract-smoke.js`现在 fail closed：

- 无参数：不联网，以`AI_SMOKE_MODE_REQUIRED`拒绝；
- `--offline`：只运行确定性合成 Replay，网络调用为0；
- `--live-ai`：还必须同时设置`ALLOW_LIVE_AI_SMOKE=1`；
- Live还要求显式、无URL凭据的HTTPS `API_BASE_URL`；
- 任一开关或endpoint缺失都在fetch之前拒绝；
- Live错误不再打印远端response body，成功日志只打印hostname。

Live模式不属于本轮回归白名单，也未在本阶段运行。

## 3. 统一离线入口

所有Record回归通过：

```text
node scripts/run-record-offline-regression.js --test <ALLOWLIST_ID>
```

入口只接受集中白名单中的Node脚本，不接受任意命令、目录遍历或“运行所有scripts”。
全量报告只能显式写入`/private/tmp`。子进程环境会移除：

- AI/API/Qwen/DashScope/OpenAI等key、token、Authorization、Cookie和secret变量；
- `API_BASE_URL`、`HUOXIAOLING_API_BASE_URL`；
- Live授权开关；
- HTTP/HTTPS/ALL proxy变量；
- 宿主`NODE_OPTIONS`。

入口重新设置固定preload和`RECORD_OFFLINE_MODE=1`。Validator、Case Worker、Restart
Worker及其Node子进程继承同一门禁；项目生产模块加载前门禁已经安装。

## 4. 进程级Node网络门禁

preload覆盖：

```text
global.fetch
http.request
http.get
https.request
https.get
net.connect
net.createConnection
net.Socket.prototype.connect
tls.connect
```

任何调用立即抛出`AUTOMATION_NETWORK_GUARD_ERROR`。跨子进程审计只记录API类型、
目标host/port、调用脚本和脱敏stack摘要，不记录headers、Body、query、userinfo或环境
变量值。任何正式回归出现一次attempt，整个测试退出失败；不能归为产品`CASE_FAIL`。

该门禁防止项目当前Node调用链和常规依赖误联网，不是对恶意native addon或任意外部
二进制的OS级隔离。回归白名单只启动固定Node脚本，不包含curl、浏览器、真实AI quality
脚本或微信真实页面E2E。

## 5. 自测与全量证据

离线安全自测15/15，覆盖默认拒绝、Offline Replay、Live双开关、fetch/https/net阻断、
Worker/子进程继承、密钥剥离、Evidence脱敏、attempt整轮作废和产品失败分类边界。

最终120题两轮均满足：

```text
RUNNER_ERROR                     = 0
BLOCKED                          = 0
realNetworkRequests              = 0
networkGuardAttempts             = 0（统一离线入口控制台审计；未嵌入下述全量JSON）
unknownFakeRouteRequests         = 0
realWxStorageCalls               = 0
hostFilesystemStorageCalls       = 0
fixtureMutationCount             = 0
crossCaseLeakCount               = 0
journalCount                     = 0
backupCount                      = 0
parserEvidenceMissingCount       = 0
orphanRawInvocationCount         = 0
uncorrelatedInvocationCount      = 0
shadowParserInvocationCount      = 0
isolationAuditNotExecutedCount   = 0
```

脱敏全量报告位于：

```text
/private/tmp/record-parser-payment-intent-v1-offline-final.json
```

该临时报告不进入Git，也不构成真实千问或微信真机结论。
