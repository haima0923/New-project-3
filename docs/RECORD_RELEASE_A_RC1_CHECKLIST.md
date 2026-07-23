# 记一笔基础设施 Release A RC1 候选清单

> 状态：候选构建，尚未上传、发布或推送。生产模式固定为
> `LEGACY_ONLY`，`SHARED_COMMIT` 继续禁用。

## 1. 候选范围

Release A RC1 只把现有 Legacy 整包业务状态写入接入统一基础设施：

```text
现有 Legacy 业务逻辑
→ Release A Writer Coordinator
→ revision / 双 fingerprint CAS
→ sealed Backup / Journal
→ 单 Bundle 写入
→ 立即读回校验
→ 有界 Receipt
→ 清理事务材料
```

包含：

- 23 个生产业务 Bundle 写入点的受控来源标识；
- 唯一生产写入组合根 `utils/storage.js`；
- 启动恢复先于初始化；
- Recovery Lock；
- 同进程串行临界区与 stale 快照阻断；
- 本地、内存、有界、脱敏技术监测；
- 旧 Bundle 首次业务写入时的兼容升级。

不包含：

- 生产 Shared SavePlan / Commit；
- 页面解析或保存调用迁移；
- 真实用户 Shadow、canary 或灰度；
- 在线远程 kill switch；
- 客户端版本覆盖统计；
- 真机断电验证、真实 AI 或发布。

## 2. Writer 收敛清单

所有写入仍由原页面函数发起，页面不接触事务细节。

| # | writerSource | 当前业务入口 |
| ---: | --- | --- |
| 1 | `APP_LAUNCH_INITIALIZE` | App 启动恢复后首次初始化 |
| 2 | `PENDING_IGNORE` | 忽略待整理 |
| 3 | `CUSTOMER_MERGE` | 客户合并 |
| 4 | `CUSTOMER_DUPLICATE_REVIEW` | 重名复核 |
| 5 | `ONBOARDING_META` | onboarding 状态 |
| 6 | `TODO_COMPLETE` | 完成提醒 |
| 7 | `RECORD_SOFT_DELETE` | 软删除 |
| 8 | `RECEIVABLE_PAYMENT` | 待收页收款、部分收款或结清 |
| 9 | `RECEIVABLE_DUNNING` | 待收页催款 |
| 10 | `DASHBOARD_FORMAL` | 首页正式记一笔 |
| 11 | `DASHBOARD_PENDING` | 首页保存待整理 |
| 12 | `ORDER_STATUS` | 更新订单状态 |
| 13 | `ORDER_DELIVERY` | 更新交期 |
| 14 | `ORDER_GENERATE_RECEIVABLE` | 订单生成待收款 |
| 15 | `FINANCE_PAYMENT` | 财务页收款、结清或定金相关保存 |
| 16 | `FINANCE_DUNNING` | 财务页催款 |
| 17 | `FINANCE_GENERATE_RECEIVABLE` | 财务页生成待收款 |
| 18 | `QUOTATION_CONVERT` | 报价转订单 |
| 19 | `CATALOG_AUTO_MIGRATION` | 商品目录自动兼容迁移 |
| 20 | `CATALOG_MANUAL_SAVE` | 商品目录保存 |
| 21 | `CATALOG_MANUAL_DELETE` | 商品目录删除 |
| 22 | `INPUT_FORMAL` | 完整页正式记一笔 |
| 23 | `INPUT_PENDING` | 完整页保存待整理 |

编辑待整理、待整理转正式、更新报价、更新提醒、定金等产品动作由完整页或首页
正式记一笔入口表达，不形成额外的业务 Bundle 写入旁路。静态门禁要求生产代码中
不存在直接以 `yiwu_boss_ai_assistant_v1` 为目标的 `setStorageSync` 或
`removeStorageSync`。

## 3. 启动顺序

生产 `App.onLaunch` 必须先调用：

```text
prepareRecordStorageInfrastructure()
```

顺序固定为：

1. 建立可信 wx Gateway 与 Release A Coordinator；
2. 检查并恢复 Backup、Journal、主 Bundle 和 Receipt；
3. 若恢复矛盾，进入 Recovery Lock，禁止初始化和业务写入；
4. 若已有有效 Bundle，只读返回，不增加 revision、Receipt 或 fingerprint；
5. 只有主 Bundle 不存在时，才通过同一事务入口创建初始 Bundle。

禁止恢复前调用 `initializeState()`，也禁止为了补 meta 在纯启动时强制写回。

## 4. 成功、失败与页面兼容

底层状态至少区分：

```text
LEGACY_SAVE_COMMITTED
LEGACY_SAVE_ALREADY_COMMITTED
LEGACY_SAVE_STALE
LEGACY_SAVE_PREWRITE_FAILED
LEGACY_SAVE_ROLLED_BACK
LEGACY_SAVE_RECOVERY_REQUIRED
LEGACY_SAVE_CAPACITY_BLOCKED
LEGACY_SAVE_READBACK_FAILED
LEGACY_SAVE_FAILED
```

现有页面成功路径保持同步返回；任何 stale、rollback、recovery、容量、readback 或
一般失败均同步抛出，页面不能继续显示成功。恢复状态不明确时不得绕过 Coordinator
直接写 Legacy。

## 5. 旧 Bundle 升级

- 没有 `meta` 或 revision 的旧 Bundle 可直接读取；
- 纯启动不写入升级；
- 首次真实业务写入确定性建立 revision 和事务控制信息；
- 顶层、`meta` 和业务记录中的未知兼容字段原样保留；
- 不凭空重建无关可选集合；
- `originalText`、`items`、金额、状态和关联保持不变。

## 6. 本地监测边界

只记录有界的技术事件：

```text
LEGACY_WRITE_DECISION
LEGACY_WRITE_COMMITTED
LEGACY_WRITE_STALE
LEGACY_WRITE_ROLLED_BACK
LEGACY_WRITE_RECOVERY_REQUIRED
LEGACY_WRITE_CAPACITY_BLOCKED
LEGACY_WRITE_READBACK_FAILED
STARTUP_RECOVERY_RESULT
WRITER_QUEUE_DELAY
```

监测仅在进程内保存，不进业务 Bundle、不写 Storage、不上传。不得记录原文、客户、
电话、商品、地址、金额、完整业务对象、Journal 或 Backup 内容。监测自身失败不得
改变保存结果。

## 7. 验证门禁

- Release A 专项全部通过；
- 22 个代表场景的旧 Legacy、Shared Memory 与事务 Legacy 业务状态一致；
- stale writer 不覆盖新状态；
- readback 失败不返回成功；
- Recovery Lock 阻断所有业务 Bundle writer；
- 已有 Bundle 的纯启动零写入；
- 缺失 Bundle 的首次初始化只发生一次；
- 旧 Bundle 与未知字段无损；
- 金融、删除、多商品和严格原文无重复或丢失；
- 微信开发者工具只使用四个隔离测试 key：不重载 16/16，五类跨重新编译场景累计
  6 个审计 Boot，真实业务 key 读/写/删及白名单外访问均为 0，最终测试 key 为 0；
- runtime test 不进入生产 `app.json`；
- production 固定 `LEGACY_ONLY`，Shared 入口不可达；
- 没有真实 AI、外网、上传、发布或 push。

## 8. 回滚候选

当前没有在线 kill switch。若 Release A 发布后发现基础设施问题，只能发布兼容修复
版本。兼容回滚构建必须继续理解：

- storage revision 与双 fingerprint；
- Backup、Journal 和 Receipt；
- Recovery Lock；
- Release A 写入后的未知 transaction meta。

不得回退到完全不认识事务控制信息、会直接覆盖整包 Bundle 的旧代码。处于未确定
事务状态时，功能级回退也不能绕过 Coordinator。

## 9. 发布前人工评审

本候选通过后只可进入人工发布评审。评审必须再次确认：

1. 候选提交和 tag 与测试证据一致；
2. 微信提交范围不包含 `runtime-test/`；
3. Shared 生产路径仍硬关闭；
4. 版本说明不声称生产保存迁移或在线回退；
5. 已准备兼容回滚构建方案；
6. 仍缺少活跃客户端版本覆盖率，不能开始 Shared canary。

评审通过后，是否上传体验版由老板单独决定；本候选不执行上传。
