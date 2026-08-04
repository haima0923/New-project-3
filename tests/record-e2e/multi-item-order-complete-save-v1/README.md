# 多商品订单完整保存 V1 失败优先合同

本专项只冻结已确认的多商品生产缺口，不修改生产规则，也不计入核心题数。

运行：

```bash
node tests/record-e2e/multi-item-order-complete-save-v1/run.js --repeat 2
node tests/record-e2e/multi-item-order-complete-save-v1/run.js --case-id REC-E2E-MIO-RED-001 --json
node tests/record-e2e/runner-tests/multi-item-order-complete-save-contract-tests.js
```

当前冻结基线上，`run.js` 应因 7 个真实合同缺口返回退出码 1；这不是 Runner 错误。退出码 2 才表示 Runner、数据、阻断分类或确定性错误。三个 GREEN control 必须保持 PASS，证明测试并非无条件失败。

证据等级严格分开：

- RED-001 使用真实本地 parser。
- RED-002 至 RED-004 使用 Controlled AI Fixture，只验证 merge/safety，不是 REAL AI。
- RED-005 至 RED-007 直接验证 domain/business 合同。
- GREEN control 只证明已有可信 final draft 时的 business 条件式能力。
- 本专项不调用 REAL AI，不执行 Page VM，也不冒充真实 WXML/微信运行时。
- Fake Provider 页面生产阻断与 TEST_ONLY isolated commit 继续由现有核心 MULTI Runner 分层报告，不能算作生产正式保存成功。

所有案例统一冻结：

- `businessDate = 2026-08-04`
- `nowInstant = 2026-08-04T02:30:00.000Z`
- `timezone = Asia/Shanghai`
- `Date`、`Date.now` 和 `Math.random`

金额合同使用整数分断言，核心样例为 `196460 + 271150 = 467610`。
