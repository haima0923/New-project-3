# 合法普通单商品订单完整保存 V1

本专项是失败优先测试合同，不属于核心 120 题计数，也不修改任何生产规则。

## 范围

- 手工文字输入、单一客户、单一商品、明确数量/单位/价格/交期。
- 首页 `confirmQuickSave` 与完整页 `saveFormal` 都必须通过真实页面方法执行。
- 正式保存必须通过真实 `saveConfirmedDraft` 和 `saveState`，再由真实订单列表和记录详情页面重读。
- 单独验证页面重开、新进程重启、连续点击、精确事务重放、旧快照并发和存储故障回滚。
- 明确排除多商品、语音、粘贴聊天、AI 补事实、报价转单、订单更新和财务业务。

## 运行

```bash
node tests/record-e2e/single-item-order-complete-save-v1/surface-run.js
node tests/record-e2e/single-item-order-complete-save-v1/run.js --repeat 2
node tests/record-e2e/single-item-order-complete-save-v1/run.js --case-id REC-E2E-SIO-001 --json
```

`surface-run.js` 的 20 项检查只证明测试表面可真实执行和可观测；56 条业务合同的 `PASS` / `CASE_FAIL` 才说明当前生产行为是否满足产品合同。运行器错误、阻塞和页面表面错误必须始终为零。

## 报告口径

每条结果分别记录：初始持久化状态、输入、页面入口、本地解析路由、AI 调用数、确认态字段、页面正式保存次数、业务构造结果、`saveState` 次数与结果、版本/收据变化、真实重读状态、列表、详情、重启、并发/故障证据和禁止出现的数据。

报告中的四个概念不得混用：

- 页面正式保存：真实调用 `confirmQuickSave` 或 `saveFormal`。
- 测试隔离提交：测试为事务重放/并发单独构造的隔离提交，不代表页面动作。
- 真实存储提交：真实 `saveState` 返回已提交。
- 重新读取成功：丢弃内存返回值后，真实 `getState`、列表和详情仍读到同一订单。
