# 记一笔共享保存受控切换计划

> 状态：**Release A RC1 基础设施候选已接入生产 Legacy 写入链；production 固定
> `LEGACY_ONLY`；`SHARED_COMMIT` 禁用；没有真实用户 canary；尚未上传或发布。**

## 1. 当前真实控制能力

| 能力 | 当前事实 | 能否影响已发布客户端 | 紧急回退结论 |
| --- | --- | ---: | --- |
| 构建静态配置 | 有，默认且唯一生产模式为 `LEGACY_ONLY` | 否，需发布新版本 | 版本级回退 |
| 本地 Storage / 页面参数 | 不可信，不得决定保存模式 | 不适用 | 明确拒绝 |
| 登录响应 / server 配置 | 没有保存切换字段或可信配置接口 | 否 | 不能作为回退 |
| 可信远程配置 | 不存在 | 否 | 不具备在线 kill switch |
| 开发隔离配置 | 有受保护 Fake/Local Provider | 只用于 Node、Memory/Fake/隔离 wx key | 只用于演练 |
| 客户端版本覆盖率 | 不存在可信统计 | 否 | 无法证明旧 writer 退出 |

因此当前结论是：

> 只能通过构建配置或重新发布版本完成全局回退，不具备已发布用户的在线一键回退。

不得用本地 Storage、环境变量、页面参数或普通对象伪造远程开关。未来若增加可信远程配置，必须另行验证鉴权、防伪、版本、过期、缓存、离线默认和审计；本阶段没有实现该服务。

## 2. 不变量

1. 生产只允许 `LEGACY_ONLY`，普通输入无法提升模式。
2. Shared 可能触碰主 Bundle 后，绝不自动再执行 Legacy。
3. `RECOVERY_LOCKED` 同时阻断 Shared 与 Legacy，kill switch 不能绕过。
4. `STALE_STORAGE_SNAPSHOT`、plan 碰撞和金融不变量失败只阻断并重建，不用旧草稿覆盖。
5. Shared 资格必须绑定完整 Confirmation、Preflight、SavePlan、state revision/fingerprint 和受保护隔离证据。
6. 监测不记录原文、客户、电话、商品、金额、完整记录或错误 message/stack。
7. 控制器只做决策，不执行保存，不读写 Storage，不上传监测。

## 3. 切换模式

| mode | primary | shadow | 当前生产可用 |
| --- | --- | --- | ---: |
| `LEGACY_ONLY` | Legacy | 无 | 是，唯一模式 |
| `SHADOW_PREVIEW` | Legacy | Shared 内存预演 | 否；仅隔离测试 |
| `SHARED_CANARY` | Shared | Legacy 模拟 | 否；仅受保护隔离证据 |
| `SHARED_PRIMARY` | Shared | Legacy 模拟 | 否；仅受保护隔离证据 |
| `RECOVERY_LOCKED` | 阻断 | 无 | 作为安全锁状态 |

`SHADOW_PREVIEW` 中 Shared 不得写真实业务 key；只有配置的 shadow sample rate 非零且受保护证据明确命中抽样时才运行预演。完整 Shadow 双跑当前只在合成 state 和隔离 store 中执行。生产页面和 `business.js` 仍没有接入控制器。

## 4. 可信配置与证据

配置 Provider 使用私有注册身份。构建 Provider 只能签发生产 `LEGACY_ONLY + killSwitch`；Fake/Local Provider 只能用于隔离环境。已解析配置深度冻结，普通对象、克隆对象或原地篡改不能成为可信配置。

共享资格还需要私有注册的隔离证据，至少绑定：

- app/build 版本；
- Release A 覆盖、旧 writer 退出和事务兼容 Legacy 能力；
- canary cohort 与抽样结果；
- recovery、transaction、readback、receipt、metadata 和事务材料清洁状态。

普通布尔值不能自报“Release A 已覆盖”或“属于 canary”。当前没有生产证据签发器，所以真实用户永远不能取得 Shared 资格。

Storage target 必须由受保护工厂创建，并绑定同一个可信 `TRANSACTION_PREVIEW` Coordinator；targetKind 与 Coordinator 的真实 Gateway 身份必须一致。当前只接受 Memory、Fake 或开发者工具隔离 key，不接受真实业务 Storage。

回退资格另由受保护的 transaction outcome 表达，并绑定同一个可信 Coordinator。普通调用方传入的 `fallbackStage`、base/revision/fingerprint 匹配布尔值或“已回滚”声明不能解锁 Legacy。配置中的 `fallbackPolicy` 是硬上限：`NO_FALLBACK` 不能被控制器自动提升为写前或已验证回滚。

受保护 evidence 中的 transaction/recovery 状态具有最高优先级；普通输入与可信状态不一致时按元数据冲突进入 Recovery Lock，不能把 `COMMITTED` / `RECOVERY_REQUIRED` 降级伪装成 `ROLLED_BACK`。

## 5. Shared 资格门禁

以下条件必须同时成立：

1. 配置 Provider 与解析结果可信且未过期；
2. requested/effective mode 允许 Shared；
3. build version 与 flavor 在显式 allowlist；
4. Storage schema 和 transaction protocol 精确受支持；
5. Storage target 与 Coordinator 身份可信且绑定一致，实际 Coordinator schema 精确达到配置门槛；
6. recovery/transaction 明确为 `CLEAN`；
7. readback、receipt、metadata 和事务材料全部明确一致；
8. businessType 与 operation 在显式 allowlist；
9. Preflight 允许正式保存；
10. Confirmation 绑定有效；
11. SavePlan 通过 `validatePlanShape()` 的完整 schema、hash、幂等、依赖、diff 和非空操作校验；
12. plan 与当前 confirmation/preflight/state revision/fingerprint 一致；
13. resultScope 为 `PRODUCTION_RESULT`；
14. provider 为 `REAL`，或为明确 production-local、AI 未请求的 `NONE`；
15. Shadow 无业务、金融、关系、丢失或未知差异；
16. Release A 覆盖、旧 writer 退出和事务兼容 Legacy 能力具有受保护证据；
17. canary 模式还需可信 cohort policy 与配置精确匹配、抽样通过和非零 sample rate；
18. 没有终局、模糊或禁止回退状态。

缺一项即不能进入 Shared。

## 6. 路径决策

统一决策输出：

```text
requestedMode / effectiveMode
primaryPath = LEGACY | SHARED | BLOCKED
shadowPath = NONE | SHARED_PREVIEW | LEGACY_SIMULATION
sharedEligibility / legacyEligibility
fallbackPolicy / fallbackAllowedNow
requiresRecovery
monitoringEvents
decisionReason
```

业务页面未来只能消费该决策，不得自行切换路径。本阶段页面没有接入。

## 7. 回退矩阵

| 阶段 | 自动 Legacy | 条件 |
| --- | ---: | --- |
| Confirmation 前 | 可考虑 | 最新 state、Legacy Preflight 与重复风险重新验证 |
| Shared 资格失败 | 可考虑 | 尚未创建事务材料，Legacy 自身安全 |
| SavePlan 前失败 | 可考虑 | 尚未创建事务材料，重新构建 Legacy 输入 |
| `BEFORE_TRANSACTION_MATERIALS` | 可考虑 | 明确尚未写 Backup/Journal |
| Backup 已写 / Journal 写前 | 否 | 已有持久化事务材料 |
| Journal `PREPARED` | 仅已验证回滚后 | 旧 Bundle、revision、fingerprint 全匹配，无成功 receipt，重读并重做 Preflight |
| 主 Bundle 可能已写 | 否 | 进入阻断或恢复 |
| readback / receipt 不确定 | 否 | 进入 Recovery Lock |
| Shared 已提交 | 否 | 只返回已提交/幂等结果 |
| stale / plan 碰撞 | 否 | 重新读取并完整重建 |
| 金融不变量失败 | 否 | 人工检查，不自动换路径 |

`BEFORE_JOURNAL` 不是安全写前边界，因为当前协议先写 Backup；安全边界必须明确为 `BEFORE_TRANSACTION_MATERIALS`。所有可回退证明必须来自与当前 Coordinator 绑定的受保护 outcome；未知、非法、`FAILED`、未验证的 `ROLLED_BACK` 或普通参数声明全部 fail closed。

## 8. Recovery Lock

以下情况触发 `RECOVERY_LOCKED`：

- 配置明确锁定；
- `RECOVERY_REQUIRED`；
- `PREPARED`、`MAIN_WRITE_STARTED`、`COMMIT_OUTCOME_UNKNOWN`；
- `COMMITTED_CLEANUP_PENDING`；
- Journal/Backup 未解决或互相矛盾；
- readback 不确定；
- receipt 与 Bundle 冲突；
- transaction metadata 或材料损坏。

锁定后两条写路径都不可用，只允许读取和恢复。kill switch 只能影响下一笔尚未开始的保存，不能中断、改道或绕过恢复中的事务。

## 9. Shadow 差异

分级：

```text
NO_DIFFERENCE
NON_BUSINESS_METADATA_ONLY
ORDERING_ONLY
LOGGING_ONLY
BUSINESS_STATE_DIFFERENCE
FINANCIAL_DIFFERENCE
RELATION_DIFFERENCE
DATA_LOSS
UNKNOWN
```

业务、金融、关系、数据丢失和未知差异全部阻断 Shared。`equivalent=true` 但仍有 difference 条目属于自相矛盾，按 `UNKNOWN` 阻断。

## 10. 技术监测

本阶段监测只在可信配置明确启用时写入内存，FIFO 有界，支持清理；不进业务 Bundle、不写 Storage。`remoteUploadEnabled` 在规范化时固定为 false，普通配置不能打开远程上传。

允许：

- app 语义版本；
- config version 的短指纹；
- mode、businessType、operation 的严格枚举；
- 技术错误码；
- revision、transaction state；
- planHash 短指纹；
- diff 分类、耗时和记录数量变化。

禁止：

- originalText、聊天、客户、电话、地址；
- 商品、规格、items；
- 金额、价格、待收、收款、定金明文；
- 完整 Confirmation、Preflight、SavePlan、receipt、diff、state；
- error message、stack 和任意自由 details。

任何未知业务类型、操作或错误只记录技术占位符，不保留自由文本。

## 11. Release A / B / C

### Release A：基础设施版本

- 固定 `LEGACY_ONLY`；
- RC1 候选已让 23 个生产 Legacy writer 经统一 Coordinator、revision/CAS、恢复和
  本地脱敏技术监测；
- 启动先恢复，已有 Bundle 纯读取零写入，缺失 Bundle 才事务初始化；
- 不开启 Shared；
- 验证现有 Legacy 语义与稳定性；
- 建立可信 app version 和活跃版本覆盖能力；
- 明确事务兼容 Legacy writer，不能使用 revision 0 passthrough 覆盖 Shared 状态。

### Release B：内部 canary

只有 Release A 覆盖与旧 writer 退出可证明后才设计执行：

- 仅受控内部设备；
- 可信配置和设备/版本身份；
- 最小 businessType/operation allowlist；
- 只影响下一笔尚未开始的事务；
- 任一停止指标立即停止后续 Shared；
- 仍不能把构建开关称为在线 kill switch。

### Release C：逐步扩大

仅在内部 canary 无业务差异、无恢复事件、无敏感监测且具备可信版本覆盖后评估。金融业务最后进入，Legacy 实现仍保留。

当前没有客户端版本覆盖率，也没有可信远程配置，所以不能开始真实用户 canary。

## 12. 初始 canary 风险排序

这只是供老板后续决策的风险排序，不决定首个真实业务类型：

1. 待整理；
2. 独立普通提醒；
3. 明确新建、无历史关系的简单报价；
4. 明确新建的单商品简单订单；
5. 多商品、历史更新、报价转订单、多候选关系；
6. 待收、收款、定金、结清等金融业务最后；
7. mixed、AI 低置信补全、Fake/Mock/Replay 永不进入初始 canary。

## 13. 停止指标

以下任一出现即停止后续 Shared：

- 业务、金融、关系或数据丢失差异；
- 重复记录或幂等失效；
- `RECOVERY_REQUIRED` 或 readback 失败；
- planId 碰撞；
- stale writer 覆盖风险；
- 未知错误分类；
- 监测出现敏感信息；
- 旧 writer 仍活跃；
- 版本覆盖无法证明。

## 14. 当前完成边界

Release A RC1 已实现生产 Legacy writer 的事务保护组合根，但仍只是尚未上传的候选：

- 页面调用方式和 Legacy 业务逻辑不变；
- Shared SavePlan/Commit 没有成为生产主路径；
- 监测只在本地内存中有界保存，不远程上传；
- 没有可信远程配置、在线 kill switch 或客户端版本覆盖率；
- 微信运行时验证只使用仓库外独立项目和隔离测试 key。

下一步只能进入 Release A 人工发布评审。即使评审通过，也必须由老板另行决定是否
上传体验版；在客户端基础设施覆盖得到可信证明前，不得开始 Shared canary。

## 15. Release A RC1 回滚边界

当前全局回退仍是版本级回退，不是在线一键回退。兼容回滚版本必须继续理解 Release A
写入后的 revision、fingerprint、Backup、Journal、Receipt 和 Recovery Lock，不能
退回会无条件覆盖整包 Bundle 的旧 writer。

事务状态不明确、readback 不确定或处于 Recovery Lock 时，功能级回退也不得绕过
Coordinator。详细候选范围与人工评审项见
`docs/RECORD_RELEASE_A_RC1_CHECKLIST.md`。
