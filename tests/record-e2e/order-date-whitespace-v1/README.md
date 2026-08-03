# 普通订单日期空白完整保存合同 V1

本组固定业务日期为 `2026-08-03`，验证数字、年月日单位和 `/`、`-` 分隔符附近的普通空格、全角空格及不换行空格。

14 种正向输入分别经过首页和完整“记一笔”页面，共 28 条。每条都必须证明：

```text
原始输入
→ 原始 Parser dueDate
→ Hybrid dueDate（AI 调用 0）
→ 页面确认态 dueDate
→ 日期控件零操作
→ 正式保存一次
→ 真实存储重读订单交期
```

安全反例 `下 周 五交` 必须继续保持无法识别，禁止用删除任意词内空白的方式修复。

运行：

```bash
node tests/record-e2e/order-date-whitespace-v1/run.js --repeat 2
```

本组不使用 fixture 预填交期，不操作日期控件，不调用 AI 补日期，也不修改现有 56 条单商品合同。

失败优先冻结证据（修复前）：连续两轮均为 `PASS 8 / CASE_FAIL 20 / RUNNER_ERROR 0 / BLOCKED 0 / SURFACE_ERROR 0`，20 个失败的首个丢失点均为原始 Parser `dueDate` 为空。

最小生产修复后：连续两轮均为 `PASS 28 / CASE_FAIL 0 / RUNNER_ERROR 0 / BLOCKED 0 / SURFACE_ERROR 0`；安全反例仍为未识别。
