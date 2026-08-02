# 报价真实用户入口测试

本目录包含两组互相独立的入口合同：

- `run.js`：原有 14 条报价详情入口合同；
- `interaction-run.js`：36 条报价取消、报价专属左滑和直接选择交期合同。

两组都复用 `quotation-to-order-save-v1` 的隔离状态夹具，不修改该测试组的输入或期望，
也不计入核心 120 题。

运行：

```text
node tests/record-e2e/quotation-detail-convert-entry-v1/run.js --repeat 2
node tests/record-e2e/quotation-detail-convert-entry-v1/interaction-run.js --repeat 2
```

测试会真实加载记录页、报价详情页和报价页的方法，捕获导航、弹窗、存储读取、
`saveState`、`cancelQuotation`、`softDeleteRecord` 和 `convertQuotationToOrder` 调用。
取消报价必须保留历史、幂等且不经过删除逻辑；详情页和记录页转单入口必须保持零正式保存、
零直接转换，所有转单业务写入只能发生在现有报价页。
