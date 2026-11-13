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
全量报告默认写入系统临时目录（Node `os.tmpdir()`）；显式 `--output` 与报告写入器共用校验，
只允许仓库外的临时目录绝对路径，拒绝仓库内、相对路径和临时目录前缀相似的逃逸路径。
保留 macOS `/private/tmp`、`/tmp` 兼容；Windows 使用当前用户的系统临时目录。
网络审计及相关自测也使用系统临时目录。子进程环境会移除：

- AI/API/Qwen/DashScope/OpenAI等key、token、Authorization、Cookie和secret变量；
- `API_BASE_URL`、`HUOXIAOLING_API_BASE_URL`；
- Live授权开关；
- HTTP/HTTPS/ALL proxy变量；
- 宿主`NODE_OPTIONS`。

入口重新设置固定preload和`RECORD_OFFLINE_MODE=1`。Validator、Case Worker、Restart
Worker及其Node子进程继承同一门禁；项目生产模块加载前门禁已经安装。

Windows 测试兼容修复仅规范化发布检查和测试采集器的路径分隔符、兼容调用栈中的盘符；
不修改生产 parser 或解析证据的判定规则。领域预检及 Release A 等价样例使用其固定业务日期
运行，异步结束或失败后恢复宿主时钟和时区；历史交期安全保护仍由独立负例验证。

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

以下为历史基线证据；2026-10-28 的 Windows 重跑结果见第 6 节。

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

## 6. Windows 回归基线（2026-10-28）

- 源代码基线：`fe7e5a3`，本轮只改测试入口、测试辅助、测试采集器、自测和本文档。
- 离线保护自测 `18/18`、全量/报告自测 `28/28`、调用图自测 `26/26`、领域预检 `30/30` 通过。
- 收款余额专项 `9/9` 与 AI P0 安全回归通过；未修改对应生产逻辑。
- 核心 120 题双轮均为 `PASS=8 / CASE_FAIL=112 / RUNNER_ERROR=0 / BLOCKED=0`，确定性为 `STABLE`。
- 61 条 P0 失败单题重跑、11 条 P1 分层重跑完成；28 个 Cluster 覆盖全部 112 条失败。
- 两轮网络、真实微信 Storage、宿主文件系统业务存储、fixture 变更和解析证据缺失计数均为 0。
- Release A 路径误报和等价样例日期误报已消除；第 4 项仍因 Legacy/Shared 结果中的
  `confirmationItemKey` 元数据差异失败，未删除该断言，也未执行之后的 12 项。
- `CASE_FAIL` 仍须区分产品缺陷、测试合同及观察预期差异；执行完成和退出码 0 不等于发布验收通过。
- 脱敏全量报告名为 `huoxiaoling-windows-baseline-20261028-run1.json`，位于系统临时目录，未进入 Git。
- 本轮未调用真实 AI、未进行微信 WXML 或真机验收，未提交、推送、上传或发布。

## 7. 确认提示与重复核对修复后（2026-10-28）

第 6 节保留为本机首次基线。随后授权的生产修复仅涉及确认卡页面与最终安全核对。
专项验证、完整测试结果及未通过项见
[确认提示、首页转交与重复核对修复](RECORD_CONFIRMATION_CONSISTENCY_FIX_20261028.md)。

- 核心 120 题两轮均为 `PASS=10 / CASE_FAIL=110 / RUNNER_ERROR=0 / BLOCKED=0`，结果稳定，无新增失败。
- `AMB-005`、`VOICE-004` 两条确认提示问题变为 PASS，原始解析风险和真实保存限制继续保留。
- 新增 `confirmation-consistency`、`entry-handoff`、`confirmation-provenance` 白名单专项；
  验证无需记录提示、风险保留、重复核对稳定性、转交边界和真实人工确认身份。
- Shared Core 独立样例使用其固定时钟，防止日期随运行月份变化造成误报。
- Release A 中的商品身份差异消除后，仍被定金日期默认值差异阻止；未删除或忽略失败断言。
- 全量报告为系统临时目录中的 `huoxiaoling-confirmation-fix-20261028.json`，不进入 Git。

## 8. 保存日期一致性修复后（2026-10-29）

- 新增 `save-date-consistency` 离线白名单专项，日期检查 `17/17` 通过。
- 新保存内存、Preview、持久化事务、隔离静态检查和 Release A 分别为 `22/22`、`13/13`、
  `22/22`、`19/19`、`16/16`；生产 Shared Commit 继续关闭。
- `shared-core-phase1e2a2-static` 纳入同一离线门禁；wx API double 不代表真机证据。
- 核心 120 题两轮仍为 `10/110/0/0`，与上一轮逐题状态一致；所有真实网络和真实存储计数为 0。
- 全量报告为系统临时目录中的 `huoxiaoling-save-date-fix-20261029.json`，不进入 Git。
- 范围、测试样例更正、安全反例与剩余问题见
  [保存日期一致性与可靠性修复](RECORD_SAVE_DATE_CONSISTENCY_FIX_20261029.md)。

## 9. 主流程修复后（2026-11-10）

- `user-journey` 通过真实页面方法、记录页和详情重读验证 27 个场景，默认执行两轮并检查结果稳定。
- 人工凭据、回答类型、商品事实、输入采集、人工字段防伪和路径合同均纳入同一离线白名单。
- 权限扫描统一 Windows 路径比较，批准签发文件仍为原有两个，服务器仍无签发引用。
- 核心 120 题双轮为 `15/105/0/0`；真实网络、真实 Storage、宿主业务文件写入、解析证据和财务安全违规计数为 0。
- 全量报告为系统临时目录 `huoxiaoling-main-journey-20261110-final.json`，不进入 Git。
- 受控 transport 的成功只证明代码路径，不代表真实模型或微信真机验收。
- 具体范围、源码重放对照及剩余问题见 [主流程验收](RECORD_MAIN_JOURNEY_FIX_20261110.md)。

## 10. 常用说法修复与来源检查核对后（2026-11-10）

- 新增 `common-phrasing-parser` 白名单，46/46；`user-journey` 扩展到45个场景，双轮全部通过。
- 逐题核实后仅更正9条 Case 的提案来源标记；业务安全、金额、日期、原话和持久化断言继续保留。
- 核心120题双轮为 `24/96/0/0`，原有15项通过保留，真实网络、真实Storage及安全违规计数为0。
- Runner内核仍有1条既有语音商品提取失败，结果为78/79；没有修改Expected隐藏这一产品问题。
- 全量报告在系统临时目录 `huoxiaoling-common-phrases-20261110-final.json`，压缩证据在仓库外备份目录。
- 未进行真实模型、微信渲染、真机或发布验收。详见 [本轮结果](RECORD_COMMON_PHRASING_FIX_20261110.md)。

## 11. 无标点口语商品识别修复后（2026-11-11）

- 新增 `oral-quantity-parser` 离线白名单，34/34；`user-journey` 扩展到55项，双轮全部通过。
- VOICE-006本地Parser事实完整后自然走LOCAL，测试配置同步为LOCAL_ONLY；保留原文、日期、金额和State Diff断言。
- 同一现行合同只读加载旧Parser仍失败，证明修复不是仅更改Expected。未放宽生产Provider信任政策。
- 核心120题双轮为 `25/95/0/0`，原有24项通过保留，Runner内核79/79；所有真实网络、真实存储与安全违规计数为0。
- 全量报告在系统临时目录 `huoxiaoling-oral-quantity-20261111-final.json`，压缩证据归档到仓库外备份目录。
- “三角架”等旧名称校验限制继续安全阻断；未进行真实模型、微信渲染、真机或发布验收。详见 [本轮结果](RECORD_ORAL_QUANTITY_FIX_20261111.md)。

## 12. 数字商品名与采购数量修复后（2026-11-11）

- 新增 `product-name-parser`、`ai-source-coverage` 白名单，35/35与86/86；`user-journey` 扩展到67项，双轮全部通过。
- 合法复合名称不再当作金额或采购数量；纯价格、纯数量、来源缺失、人工凭据和财务保护继续验证。
- 核心120题双轮仍为 `25/95/0/0`；逐题状态、业务Diff均与前一阶段一致，未修改核心Expected或fixture。
- 真实网络、真实Storage、宿主业务文件写入、串题、重复/超额收款和关系信任违规计数均为0。
- 全量报告在系统临时目录 `huoxiaoling-numeric-product-20261111-final.json`，另有仓库外压缩备份。
- 未进行真实模型、微信渲染、真机或发布验收。详见 [数字商品名修复](RECORD_NUMERIC_PRODUCT_FIX_20261111.md)。
