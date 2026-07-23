# 记一笔微信 Storage 独立运行时验证手册

> 适用阶段：Phase 1E.2A.2-R1。该验证只使用四个隔离测试 key。
> 它不迁移页面保存、不启用共享生产 Commit，也不等于真机或发布验证。

## 1. 为什么必须打开独立项目

本测试不能从货小玲主小程序进入。主小程序启动时会加载 onboarding 和业务初始化，
即使之后再跳转测试页，也已经失去“真实业务 key 从首次信任起零访问”的证明。

本轮提供独立 Mini Program 源码 `runtime-test/`，并通过脚本把它和经过审计的最小共享
依赖复制到仓库外的空白临时目录。微信开发者工具必须直接打开该临时目录。

独立项目：

- 不加载生产 `app.js`；
- 不注册 onboarding、首页或其他业务页面；
- 不包含 `utils/storage.js` 或 `utils/business.js`；
- 第一段启动代码先安装 Storage 硬白名单，再加载事务测试；
- 正式项目打包配置明确忽略 `runtime-test/`。

## 2. 允许使用的四个 key

测试只允许访问：

```text
huoxiaoling_record_txn_runtime_test_v1
huoxiaoling_record_txn_runtime_journal_v1
huoxiaoling_record_txn_runtime_backup_v1
huoxiaoling_record_txn_runtime_receipts_v1
```

真实业务 key：

```text
yiwu_boss_ai_assistant_v1
```

在独立入口中禁止读取、写入和删除。不要在 Storage 面板中手工编辑、删除或复制真实
业务 key。如果运行前已有历史值，只核对它是否仍存在，不要展开内容。

## 3. 准备独立测试目录

1. 确认 Git 分支为 `feature/record-shared-core-phase1e2a2`。
2. 由 Codex 或开发人员创建仓库外空白临时目录。
3. 运行：

```text
ELECTRON_RUN_AS_NODE=1 /Applications/wechatwebdevtools.app/Contents/MacOS/Electron \
scripts/prepare-record-storage-wx-runtime-project.js <临时目录>
```

4. Release A RC1 候选命令必须显示已复制 20 个文件。
5. 临时目录内必须有 `runtime-test-build-manifest.json`。
6. Manifest 中必须显示：

```text
productionAppIncluded: false
productionStorageIncluded: false
```

不要直接用开发者工具打开仓库根目录或 `runtime-test/` 源目录；源目录故意不保存共享
代码副本，只有经过 hash 校验的临时构建才完整可运行。

## 4. 首次信任和首次编译

1. 关闭之前的临时测试项目。
2. 用微信开发者工具直接打开上一步的临时目录。
3. 如首次出现“信任并运行”，确认当前路径是仓库外的独立测试目录后再点击。
4. 首次编译后应直接看到“独立 Mini Program”测试页。
5. 不应看到 onboarding、首页、底部导航或登录流程。
6. 页面必须显示：

```text
生产模式：LEGACY_ONLY
Shared Commit：DISABLED
真实业务key读取：0
真实业务key写入：0
真实业务key删除：0
Forbidden访问：0
```

7. 在 Storage 面板只核对四个测试 key 和真实业务 key 的“存在状态”，不要查看 value。
8. 若页面未出现、普通页面出现，或任一真实业务 key 计数不是 0，立即停止。

## 5. 先清理隔离数据

1. 点击“一键清理隔离测试数据”。
2. 结果必须为 `PASS`。
3. 页面必须显示：

```text
Revision：0
Receipt：0
Test key count：0
Forbidden访问：0
```

清理只删除四个测试 key，不能删除其他 Storage。

## 6. 运行不重载测试

点击“运行不重载测试”。应看到：

```text
WX_RUNTIME_NON_RELOAD：PASS（16通过 / 0失败）
```

16 项覆盖：

- 基础写入、立即读回和删除；
- 无 meta 旧 Bundle、未知字段、缺少可选集合和较大 Bundle；
- 正常 CAS、stale writer、无关测试 key；
- planId 碰撞和容量预检；
- writer 队列；
- 损坏值、fingerprint、transactionId 和必要集合异常。
- Release A Coordinator 的真实 wx 隔离启动、事务 Legacy 写入和 Shared 硬关闭。

结果只显示状态、revision、fingerprint、大小和错误码，不显示客户、金额或原文。

## 7. 运行五个真实重载场景

每个场景都单独执行：

1. 点击对应“准备”按钮。
2. 确认准备结果为 `PASS`，页面提示需要重新编译。
3. 不要直接点击恢复。
4. 点击开发者工具顶部“编译”，让独立 Mini Program 创建新 App 实例。
5. 确认页面 Boot 值变化。
6. 点击“重新编译后：恢复/验证”。
7. 结果必须为 `PASS`，并且 `bootChanged=true`。
8. 保存不含 Storage value 的页面截图后直接准备下一场景。准备动作只清理
   primary、journal 和 backup，保留跨 Boot 追加审计账本。

### 7.1 PREPARED 后中断

预期：旧 Bundle 保持完整；恢复为 `RECOVERED_ROLLED_BACK`；第二次恢复为 `CLEAN`。

### 7.2 主 Bundle 已写

预期：验证完整目标 Bundle，补齐 receipt；恢复为 `RECOVERED_COMMITTED`；
不重复执行业务操作。

### 7.3 主 Bundle 损坏

预期：有效 Backup 恢复完整旧 Bundle；恢复为 `RECOVERED_ROLLED_BACK`。

### 7.4 主 Bundle、Journal、Backup 矛盾

预期：`RECOVERY_REQUIRED`；第二次恢复仍为 `RECOVERY_REQUIRED`；所有材料保持，
新 writer 被阻断。下一场景的准备动作会清理当前事务材料，但保留全程审计。

### 7.5 幂等跨重载

预期：第一次 `COMMITTED`；重载后相同计划为 `ALREADY_COMMITTED`；revision、
fingerprint 和 receipt 数量不再变化；相同 planId、不同 planHash 返回
`SAVE_PLAN_ID_COLLISION`。

## 8. 怎样确认不是同进程假重载

- 准备后不编译直接恢复，必须返回 `WX_RUNTIME_TEST_REAL_RELOAD_REQUIRED`。
- 重新编译后 Boot 值必须变化。
- 场景和前一 Boot 审计摘要保存在测试 receipts key 中。
- 新实例只能从测试 primary、journal、backup 和 receipts 恢复。
- 独立入口不导入任何可保存旧页面实例状态的生产模块。

## 9. 容量与 writer 队列

页面状态显示 `wx.getStorageInfoSync()` 返回的使用量和容量上限。容量题用受控
Gateway 余量限制模拟接近配额，不会填满开发者工具 Storage。

容量题必须在第一个 Journal、Backup 或主 Bundle 写入前返回
`STORAGE_CAPACITY_INSUFFICIENT`。

writer 队列必须证明：

- 同时只执行一个事务；
- 每个 writer 执行前重新读取 revision；
- 顺序稳定；
- 一个合成失败不会锁死后续 writer。

## 10. 最终清理

1. 点击“一键清理隔离测试数据”。
2. 确认结果 `PASS`。
3. 页面必须显示：

```text
Revision：0
Receipt：0
Test key count：0
Forbidden访问：0
真实业务key读取：0
真实业务key写入：0
真实业务key删除：0
```

4. “已审计Boot”必须覆盖本轮所有实际重新编译实例；最终 0/0/0 来自清理前冻结的
   append-only 审计，而不是删除账本后的当前内存。
5. 在 Storage 面板确认四个测试 key 都不存在。
6. 不要修改真实业务 key。
7. 关闭独立临时项目。

## 11. 建议保留的证据

只保留不含 Storage value 的截图：

1. 首次信任后独立测试页和三项真实业务 key 计数 0；
2. 当前 Release A RC1 候选的 16/16 不重载测试；
3. 五个场景各自重载后的 PASS；
4. 幂等 `ALREADY_COMMITTED` 和碰撞阻断；
5. 最终四个测试 key 清理为 0。

不得导出完整 Storage，不得截图真实客户资料。

## 12. 2026-07-23 R1历史验证记录

本轮按本手册直接打开仓库外独立项目完成验证：

- 静态门禁：19/19。
- 首次启动及五次真实“重新进入小程序”：共6个不同Boot。
- 不重载矩阵：15/15。
- 跨Boot恢复：`RECOVERED_ROLLED_BACK`、`RECOVERED_COMMITTED`、backup回滚、`RECOVERY_REQUIRED`、`ALREADY_COMMITTED`均符合合同。
- planId碰撞：`SAVE_PLAN_ID_COLLISION`。
- 最终审计：真实业务key读0、写0、删0，Forbidden 0。
- 最终清理：Revision 0、Receipt 0、Test key count 0，四个隔离key全部删除。
- production仍为`LEGACY_ONLY`，`SHARED_COMMIT`仍禁用。

该记录不等于真机、真实断电、真实用户数据迁移或生产保存切换验证。

## 13. 立即停止条件

出现以下任一情况立即停止，不要手工修 Storage：

- 普通 onboarding、首页或生产 App 被加载；
- 真实业务 key 发生任何读、写或删除；
- Storage 操作绕过白名单；
- 重载后 Boot 未变化；
- receipt 丢失或 stale writer 覆盖新数据；
- 恢复清空矛盾状态材料；
- 容量题在主 Bundle 写入后才失败；
- 页面显示 `SHARED_COMMIT` 已启用；
- 四个测试 key 无法全部清理；
- 测试需要真实客户数据、网络或真实 AI。
