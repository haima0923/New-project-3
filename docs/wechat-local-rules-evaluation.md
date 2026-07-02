# 微信聊天本地规则解析 100 条离线评测报告

生成时间：2026-07-01T08:17:55.284Z

## 评测说明

- 本报告模拟 100 条不同场景的微信聊天复制内容。
- 评测链路：`analyzeClipboardText -> parseHybridInput`，在 Node 环境下没有 `wx` 和 API endpoint，因此不会调用真实 AI，相当于只看本地规则/本地兜底能力。
- “通过”表示本地结果满足该用例预期；“失败”表示字段、意图、备注、冲突提示或多记录拆分存在问题。
- 部分改价场景如果能填最终候选值并标出冲突，视为通过，因为本地规则已做到安全拦截，不会直接误存。

## 总览

- 总用例：100
- 通过：97
- 失败：3
- 通过率：97.0%

## 按场景统计

| 场景 | 用例数 | 通过 | 失败 | 通过率 |
|---|---:|---:|---:|---:|
| 报价 | 12 | 12 | 0 | 100.0% |
| 订单 | 12 | 12 | 0 | 100.0% |
| 改价确认 | 12 | 12 | 0 | 100.0% |
| 特殊要求 | 12 | 12 | 0 | 100.0% |
| 收款应收 | 16 | 16 | 0 | 100.0% |
| 更新历史 | 12 | 12 | 0 | 100.0% |
| 多产品 | 12 | 10 | 2 | 83.3% |
| 待办 | 12 | 11 | 1 | 91.7% |

## 错误类型统计

| 错误类型 | 次数 | 初步解决方向 |
|---|---:|---|
| intent_error | 2 | 把意图判断从关键词计分升级为“候选意图+证据+冲突”结构；复杂对话交给 AI 仲裁。 |
| wrong_todo_title | 1 | 待办标题用意图模板+产品/客户/动作组合，复杂句交由 AI 重写标题。 |

## 主要发现

1. intent_error：2 次。把意图判断从关键词计分升级为“候选意图+证据+冲突”结构；复杂对话交给 AI 仲裁。
2. wrong_todo_title：1 次。待办标题用意图模板+产品/客户/动作组合，复杂句交由 AI 重写标题。

## 失败样例摘录

### 080 周姐一段话多产品

- 场景：多产品
- 错误类型：intent_error
- 原因：意图打分规则被关键词误导，或缺少该类表达规则。
- 预期：intent=order；customer=周姐；multiProducts=礼品盒+收纳盒
- 实际：intent=quotation；operation=；customer=周姐；product=礼品盒、收纳盒；multi=礼品盒+收纳盒；quantity=500；unitPrice=；amount=；payment=；deposit=；due=；missing=unitPrice；low=productName；conflict=

```text
周姐
2026年07月01日 09:10
你好

海马
2026年07月01日 09:11
在的

周姐
2026年07月01日 09:12
先问礼品盒500套多少钱，再问收纳盒600个多少钱
```

### 081 钱总一段话多产品

- 场景：多产品
- 错误类型：intent_error
- 原因：意图打分规则被关键词误导，或缺少该类表达规则。
- 预期：intent=order；customer=钱总；multiProducts=包装袋+贴纸
- 实际：intent=quotation；operation=；customer=钱总；product=包装袋、贴纸；multi=包装袋+贴纸；quantity=10000；unitPrice=；amount=；payment=；deposit=；due=；missing=unitPrice；low=productName；conflict=

```text
钱总
2026年07月01日 09:10
你好

海马
2026年07月01日 09:11
在的

钱总
2026年07月01日 09:12
包装袋和贴纸一起报，包装袋1万只，贴纸2万张
```

### 091 陈老板待办提醒

- 场景：待办
- 错误类型：wrong_todo_title
- 原因：待办标题生成依赖有限模板，无法覆盖复杂说法。
- 预期：intent=todo；customer=陈老板；todoTitle=催陈老板货款；dueDate=有
- 实际：intent=todo；operation=；customer=陈老板；product=杯垫；multi=；quantity=；unitPrice=；amount=；payment=；deposit=；due=2026-07-01；missing=；low=；conflict=

```text
陈老板
2026年07月01日 09:10
下午催一下杯垫尾款
```

## 100 条明细

| ID | 场景 | 微信聊天摘要 | 是否通过 | 错误类型 | 错误原因 | 预期 | 实际 |
|---|---|---|---|---|---|---|---|
| 001 | 报价 | 王总 / 想问下水杯1000个多少钱 / 海马 / 5块5一个 | 通过 | 无 | 通过 | intent=quotation；customer=王总；product=水杯；quantity=1000；unitPrice=5.5 | intent=quotation；operation=；customer=王总；product=水杯；multi=；quantity=1000；unitPrice=5.5；amount=5500；payment=；deposit=；due=；missing=；low=；conflict= |
| 002 | 报价 | 李总 / 想问下钥匙扣2000个多少钱 / 海马 / 一块二一个 | 通过 | 无 | 通过 | intent=quotation；customer=李总；product=钥匙扣；quantity=2000；unitPrice=1.2 | intent=quotation；operation=；customer=李总；product=钥匙扣；multi=；quantity=2000；unitPrice=1.2；amount=2400；payment=；deposit=；due=；missing=；low=；conflict= |
| 003 | 报价 | 陈老板 / 想问下杯垫300个多少钱 / 海马 / 9毛 | 通过 | 无 | 通过 | intent=quotation；customer=陈老板；product=杯垫；quantity=300；unitPrice=0.9 | intent=quotation；operation=；customer=陈老板；product=杯垫；multi=；quantity=300；unitPrice=0.9；amount=270；payment=；deposit=；due=；missing=；low=；conflict= |
| 004 | 报价 | 周姐 / 想问下礼品盒500套多少钱 / 海马 / 3.8一套 | 通过 | 无 | 通过 | intent=quotation；customer=周姐；product=礼品盒；quantity=500；unitPrice=3.8 | intent=quotation；operation=；customer=周姐；product=礼品盒；multi=；quantity=500；unitPrice=3.8；amount=1900；payment=；deposit=；due=；missing=；low=；conflict= |
| 005 | 报价 | 钱总 / 想问下包装袋1万只多少钱 / 海马 / 8分钱一只 | 通过 | 无 | 通过 | intent=quotation；customer=钱总；product=包装袋；quantity=10000；unitPrice=0.08 | intent=quotation；operation=；customer=钱总；product=包装袋；multi=；quantity=10000；unitPrice=0.08；amount=800；payment=；deposit=；due=；missing=；low=；conflict= |
| 006 | 报价 | 孙总 / 想问下老款杯垫1000个多少钱 / 海马 / 还是八毛一个 | 通过 | 无 | 通过 | intent=quotation；customer=孙总；product=老款杯垫；quantity=1000；unitPrice=0.8 | intent=quotation；operation=；customer=孙总；product=老款杯垫；multi=；quantity=1000；unitPrice=0.8；amount=800；payment=；deposit=；due=；missing=；low=；conflict= |
| 007 | 报价 | 赵姐 / 想问下饰品盒800个多少钱 / 海马 / 两块三 | 通过 | 无 | 通过 | intent=quotation；customer=赵姐；product=饰品盒；quantity=800；unitPrice=2.3 | intent=quotation；operation=；customer=赵姐；product=饰品盒；multi=；quantity=800；unitPrice=2.3；amount=1840；payment=；deposit=；due=；missing=；low=；conflict= |
| 008 | 报价 | 黄老板 / 想问下五金挂件3000个多少钱 / 海马 / 单价一块五 | 通过 | 无 | 通过 | intent=quotation；customer=黄老板；product=五金挂件；quantity=3000；unitPrice=1.5 | intent=quotation；operation=；customer=黄老板；product=五金挂件；multi=；quantity=3000；unitPrice=1.5；amount=4500；payment=；deposit=；due=；missing=；low=unitPrice；conflict=unitPrice |
| 009 | 报价 | 吴总 / 想问下头绳5000条多少钱 / 海马 / 三毛五 | 通过 | 无 | 通过 | intent=quotation；customer=吴总；product=头绳；quantity=5000；unitPrice=0.35 | intent=quotation；operation=；customer=吴总；product=头绳；multi=；quantity=5000；unitPrice=0.35；amount=1750；payment=；deposit=；due=；missing=；low=；conflict= |
| 010 | 报价 | 刘总 / 想问下收纳盒600个多少钱 / 海马 / 7块8 | 通过 | 无 | 通过 | intent=quotation；customer=刘总；product=收纳盒；quantity=600；unitPrice=7.8 | intent=quotation；operation=；customer=刘总；product=收纳盒；multi=；quantity=600；unitPrice=7.8；amount=4680；payment=；deposit=；due=；missing=；low=；conflict= |
| 011 | 报价 | 马总 / 想问下小夜灯1200个多少钱 / 海马 / 4.6元一个 | 通过 | 无 | 通过 | intent=quotation；customer=马总；product=小夜灯；quantity=1200；unitPrice=4.6 | intent=quotation；operation=；customer=马总；product=小夜灯；multi=；quantity=1200；unitPrice=4.6；amount=5520；payment=；deposit=；due=；missing=；low=；conflict= |
| 012 | 报价 | 何姐 / 想问下贴纸2万张多少钱 / 海马 / 1毛2一张 | 通过 | 无 | 通过 | intent=quotation；customer=何姐；product=贴纸；quantity=20000；unitPrice=0.12 | intent=quotation；operation=；customer=何姐；product=贴纸；multi=；quantity=20000；unitPrice=0.12；amount=2400；payment=；deposit=；due=；missing=；low=；conflict= |
| 013 | 订单 | 王总 / 卡通水杯1000个先做 / 海马 / 5块5一个，月底交 | 通过 | 无 | 通过 | intent=order；customer=王总；product=卡通水杯；quantity=1000；unitPrice=5.5；dueDate=有 | intent=order；operation=；customer=王总；product=卡通水杯；multi=；quantity=1000；unitPrice=5.5；amount=5500；payment=；deposit=；due=2026-07-31；missing=；low=；conflict= |
| 014 | 订单 | 李总 / 钥匙扣2000个先做 / 海马 / 一块二一个，7天后发 | 通过 | 无 | 通过 | intent=order；customer=李总；product=钥匙扣；quantity=2000；unitPrice=1.2；dueDate=有 | intent=order；operation=；customer=李总；product=钥匙扣；multi=；quantity=2000；unitPrice=1.2；amount=2400；payment=；deposit=；due=2026-07-08；missing=；low=；conflict= |
| 015 | 订单 | 陈老板 / 杯垫300个先做 / 海马 / 9毛，明天交货 | 通过 | 无 | 通过 | intent=order；customer=陈老板；product=杯垫；quantity=300；unitPrice=0.9；dueDate=有 | intent=order；operation=；customer=陈老板；product=杯垫；multi=；quantity=300；unitPrice=0.9；amount=270；payment=；deposit=；due=2026-07-02；missing=；low=；conflict= |
| 016 | 订单 | 周姐 / 礼品盒500套先做 / 海马 / 3.8一套，后天出货 | 通过 | 无 | 通过 | intent=order；customer=周姐；product=礼品盒；quantity=500；unitPrice=3.8；dueDate=有 | intent=order；operation=；customer=周姐；product=礼品盒；multi=；quantity=500；unitPrice=3.8；amount=1900；payment=；deposit=；due=2026-07-03；missing=；low=；conflict= |
| 017 | 订单 | 钱总 / 包装袋1万只先做 / 海马 / 8分钱一只，下周发 | 通过 | 无 | 通过 | intent=order；customer=钱总；product=包装袋；quantity=10000；unitPrice=0.08；dueDate=有 | intent=order；operation=；customer=钱总；product=包装袋；multi=；quantity=10000；unitPrice=0.08；amount=800；payment=；deposit=；due=2026-07-08；missing=；low=；conflict= |
| 018 | 订单 | 孙总 / 老款杯垫1000个先做 / 海马 / 八毛一个，月底交 | 通过 | 无 | 通过 | intent=order；customer=孙总；product=老款杯垫；quantity=1000；unitPrice=0.8；dueDate=有 | intent=order；operation=；customer=孙总；product=老款杯垫；multi=；quantity=1000；unitPrice=0.8；amount=800；payment=；deposit=；due=2026-07-31；missing=；low=；conflict= |
| 019 | 订单 | 赵姐 / 饰品盒800个先做 / 海马 / 两块三，3天后拿 | 通过 | 无 | 通过 | intent=order；customer=赵姐；product=饰品盒；quantity=800；unitPrice=2.3；dueDate=有 | intent=order；operation=；customer=赵姐；product=饰品盒；multi=；quantity=800；unitPrice=2.3；amount=1840；payment=；deposit=；due=2026-07-04；missing=；low=；conflict= |
| 020 | 订单 | 黄老板 / 五金挂件3000个先做 / 海马 / 一块五，周五出 | 通过 | 无 | 通过 | intent=order；customer=黄老板；product=五金挂件；quantity=3000；unitPrice=1.5；dueDate=有 | intent=order；operation=；customer=黄老板；product=五金挂件；multi=；quantity=3000；unitPrice=1.5；amount=4500；payment=；deposit=；due=2026-07-03；missing=；low=；conflict= |
| 021 | 订单 | 吴总 / 头绳5000条先做 / 海马 / 三毛五，明天发 | 通过 | 无 | 通过 | intent=order；customer=吴总；product=头绳；quantity=5000；unitPrice=0.35；dueDate=有 | intent=order；operation=；customer=吴总；product=头绳；multi=；quantity=5000；unitPrice=0.35；amount=1750；payment=；deposit=；due=2026-07-02；missing=；low=；conflict= |
| 022 | 订单 | 刘总 / 收纳盒600个先做 / 海马 / 7块8，7月10日交 | 通过 | 无 | 通过 | intent=order；customer=刘总；product=收纳盒；quantity=600；unitPrice=7.8；dueDate=有 | intent=order；operation=；customer=刘总；product=收纳盒；multi=；quantity=600；unitPrice=7.8；amount=4680；payment=；deposit=；due=2026-07-10；missing=；low=；conflict= |
| 023 | 订单 | 马总 / 小夜灯1200个先做 / 海马 / 4.6元一个，5天后交 | 通过 | 无 | 通过 | intent=order；customer=马总；product=小夜灯；quantity=1200；unitPrice=4.6；dueDate=有 | intent=order；operation=；customer=马总；product=小夜灯；multi=；quantity=1200；unitPrice=4.6；amount=5520；payment=；deposit=；due=2026-07-06；missing=；low=；conflict= |
| 024 | 订单 | 何姐 / 贴纸2万张先做 / 海马 / 1毛2一张，月底交 | 通过 | 无 | 通过 | intent=order；customer=何姐；product=贴纸；quantity=20000；unitPrice=0.12；dueDate=有 | intent=order；operation=；customer=何姐；product=贴纸；multi=；quantity=20000；unitPrice=0.12；amount=2400；payment=；deposit=；due=2026-07-31；missing=；low=；conflict= |
| 025 | 改价确认 | 王总 / 水杯多少钱 / 海马 / 30一个 / 王总 / 贵了，25一个可以吗 / 海马 / 可以，就25一个，先做1000个，月底交 | 通过 | 无 | 通过 | intent=order；customer=王总；product=水杯；quantity=1000；unitPrice=25；dueDate=有；conflict=unitPrice | intent=order；operation=；customer=王总；product=水杯；multi=；quantity=1000；unitPrice=25；amount=25000；payment=；deposit=；due=2026-07-31；missing=；low=unitPrice；conflict=unitPrice |
| 026 | 改价确认 | 李总 / 钥匙扣多少钱 / 海马 / 1.5一个 / 李总 / 贵了，1.3一个可以吗 / 海马 / 可以，就1.3一个，先做2000个，7天后发 | 通过 | 无 | 通过 | intent=order；customer=李总；product=钥匙扣；quantity=2000；unitPrice=1.3；dueDate=有；conflict=unitPrice | intent=order；operation=；customer=李总；product=钥匙扣；multi=；quantity=2000；unitPrice=1.3；amount=2600；payment=；deposit=；due=2026-07-08；missing=；low=unitPrice；conflict=unitPrice |
| 027 | 改价确认 | 陈老板 / 杯垫多少钱 / 海马 / 1块 / 陈老板 / 贵了，9毛可以吗 / 海马 / 可以，就9毛，先做300个，明天交 | 通过 | 无 | 通过 | intent=order；customer=陈老板；product=杯垫；quantity=300；unitPrice=0.9；dueDate=有；conflict=unitPrice | intent=order；operation=；customer=陈老板；product=杯垫；multi=；quantity=300；unitPrice=0.9；amount=270；payment=；deposit=；due=2026-07-02；missing=；low=unitPrice；conflict=unitPrice |
| 028 | 改价确认 | 周姐 / 礼品盒多少钱 / 海马 / 4块一套 / 周姐 / 贵了，3.8一套可以吗 / 海马 / 可以，就3.8一套，先做500套，后天交 | 通过 | 无 | 通过 | intent=order；customer=周姐；product=礼品盒；quantity=500；unitPrice=3.8；dueDate=有；conflict=unitPrice | intent=order；operation=；customer=周姐；product=礼品盒；multi=；quantity=500；unitPrice=3.8；amount=1900；payment=；deposit=；due=2026-07-03；missing=；low=unitPrice；conflict=unitPrice |
| 029 | 改价确认 | 钱总 / 包装袋多少钱 / 海马 / 1毛一只 / 钱总 / 贵了，8分钱一只可以吗 / 海马 / 可以，就8分钱一只，先做1万只，下周发 | 通过 | 无 | 通过 | intent=order；customer=钱总；product=包装袋；quantity=10000；unitPrice=0.08；dueDate=有；conflict=unitPrice | intent=order；operation=；customer=钱总；product=包装袋；multi=；quantity=10000；unitPrice=0.08；amount=800；payment=；deposit=；due=2026-07-08；missing=；low=unitPrice；conflict=unitPrice |
| 030 | 改价确认 | 孙总 / 杯子多少钱 / 海马 / 6元一个 / 孙总 / 贵了，5块5一个可以吗 / 海马 / 可以，就5块5一个，先做800个，月底交 | 通过 | 无 | 通过 | intent=order；customer=孙总；product=杯子；quantity=800；unitPrice=5.5；dueDate=有；conflict=unitPrice | intent=order；operation=；customer=孙总；product=杯子；multi=；quantity=800；unitPrice=5.5；amount=4400；payment=；deposit=；due=2026-07-31；missing=；low=unitPrice；conflict=unitPrice |
| 031 | 改价确认 | 赵姐 / 饰品盒多少钱 / 海马 / 两块五 / 赵姐 / 贵了，两块三可以吗 / 海马 / 可以，就两块三，先做800个，3天后拿 | 通过 | 无 | 通过 | intent=order；customer=赵姐；product=饰品盒；quantity=800；unitPrice=2.3；dueDate=有；conflict=unitPrice | intent=order；operation=；customer=赵姐；product=饰品盒；multi=；quantity=800；unitPrice=2.3；amount=1840；payment=；deposit=；due=2026-07-04；missing=；low=unitPrice；conflict=unitPrice |
| 032 | 改价确认 | 黄老板 / 挂件多少钱 / 海马 / 2元一个 / 黄老板 / 贵了，一块五可以吗 / 海马 / 可以，就一块五，先做3000个，周五出 | 通过 | 无 | 通过 | intent=order；customer=黄老板；product=挂件；quantity=3000；unitPrice=1.5；dueDate=有；conflict=unitPrice | intent=order；operation=；customer=黄老板；product=挂件；multi=；quantity=3000；unitPrice=1.5；amount=4500；payment=；deposit=；due=2026-07-03；missing=；low=unitPrice；conflict=unitPrice |
| 033 | 改价确认 | 吴总 / 头绳多少钱 / 海马 / 4毛 / 吴总 / 贵了，三毛五可以吗 / 海马 / 可以，就三毛五，先做5000条，明天发 | 通过 | 无 | 通过 | intent=order；customer=吴总；product=头绳；quantity=5000；unitPrice=0.35；dueDate=有；conflict=unitPrice | intent=order；operation=；customer=吴总；product=头绳；multi=；quantity=5000；unitPrice=0.35；amount=1750；payment=；deposit=；due=2026-07-02；missing=；low=unitPrice；conflict=unitPrice |
| 034 | 改价确认 | 刘总 / 收纳盒多少钱 / 海马 / 8块 / 刘总 / 贵了，7块8可以吗 / 海马 / 可以，就7块8，先做600个，7月10日交 | 通过 | 无 | 通过 | intent=order；customer=刘总；product=收纳盒；quantity=600；unitPrice=7.8；dueDate=有；conflict=unitPrice | intent=order；operation=；customer=刘总；product=收纳盒；multi=；quantity=600；unitPrice=7.8；amount=4680；payment=；deposit=；due=2026-07-10；missing=；low=unitPrice；conflict=unitPrice |
| 035 | 改价确认 | 马总 / 小夜灯多少钱 / 海马 / 5元一个 / 马总 / 贵了，4.6元一个可以吗 / 海马 / 可以，就4.6元一个，先做1200个，5天后交 | 通过 | 无 | 通过 | intent=order；customer=马总；product=小夜灯；quantity=1200；unitPrice=4.6；dueDate=有；conflict=unitPrice | intent=order；operation=；customer=马总；product=小夜灯；multi=；quantity=1200；unitPrice=4.6；amount=5520；payment=；deposit=；due=2026-07-06；missing=；low=unitPrice；conflict=unitPrice |
| 036 | 改价确认 | 何姐 / 贴纸多少钱 / 海马 / 1毛5一张 / 何姐 / 贵了，1毛2一张可以吗 / 海马 / 可以，就1毛2一张，先做2万张，月底交 | 通过 | 无 | 通过 | intent=order；customer=何姐；product=贴纸；quantity=20000；unitPrice=0.12；dueDate=有；conflict=unitPrice | intent=order；operation=；customer=何姐；product=贴纸；multi=；quantity=20000；unitPrice=0.12；amount=2400；payment=；deposit=；due=2026-07-31；missing=；low=unitPrice；conflict=unitPrice |
| 037 | 特殊要求 | 王总 / 杯子1000个，颜色要淡一点，不要太深 / 海马 / 好的，25一个，月底交 | 通过 | 无 | 通过 | intent=order；customer=王总；product=杯子；quantity=1000；dueDate=有；remark包含=颜色要淡一点，不要太深 | intent=order；operation=；customer=王总；product=杯子；multi=；quantity=1000；unitPrice=25；amount=25000；payment=；deposit=；due=2026-07-31；missing=；low=；conflict= |
| 038 | 特殊要求 | 李总 / 钥匙扣2000个，包装袋每100个一包 / 海马 / 好的，1.3一个，月底交 | 通过 | 无 | 通过 | intent=order；customer=李总；product=钥匙扣；quantity=2000；dueDate=有；remark包含=包装袋每100个一包 | intent=order；operation=；customer=李总；product=钥匙扣；multi=；quantity=2000；unitPrice=1.3；amount=2600；payment=；deposit=；due=2026-07-31；missing=；low=；conflict= |
| 039 | 特殊要求 | 陈老板 / 杯垫300个，logo放大一点 / 海马 / 好的，9毛，月底交 | 通过 | 无 | 通过 | intent=order；customer=陈老板；product=杯垫；quantity=300；dueDate=有；remark包含=logo放大一点 | intent=order；operation=；customer=陈老板；product=杯垫；multi=；quantity=300；unitPrice=0.9；amount=270；payment=；deposit=；due=2026-07-31；missing=；low=；conflict= |
| 040 | 特殊要求 | 周姐 / 礼品盒500套，外箱不要太厚 / 海马 / 好的，3.8一套，月底交 | 通过 | 无 | 通过 | intent=order；customer=周姐；product=礼品盒；quantity=500；dueDate=有；remark包含=外箱不要太厚 | intent=order；operation=；customer=周姐；product=礼品盒；multi=；quantity=500；unitPrice=3.8；amount=1900；payment=；deposit=；due=2026-07-31；missing=；low=；conflict= |
| 041 | 特殊要求 | 钱总 / 包装袋1万只，透明度高一点 / 海马 / 好的，8分钱一只，月底交 | 通过 | 无 | 通过 | intent=order；customer=钱总；product=包装袋；quantity=10000；dueDate=有；remark包含=透明度高一点 | intent=order；operation=；customer=钱总；product=包装袋；multi=；quantity=10000；unitPrice=0.08；amount=800；payment=；deposit=；due=2026-07-31；missing=；low=；conflict= |
| 042 | 特殊要求 | 孙总 / 老款杯垫1000个，颜色按上次，不要偏黄 / 海马 / 好的，8毛，月底交 | 通过 | 无 | 通过 | intent=order；customer=孙总；product=老款杯垫；quantity=1000；dueDate=有；remark包含=颜色按上次，不要偏黄 | intent=order；operation=；customer=孙总；product=老款杯垫；multi=；quantity=1000；unitPrice=0.8；amount=800；payment=；deposit=；due=2026-07-31；missing=；low=；conflict= |
| 043 | 特殊要求 | 赵姐 / 饰品盒800个，盒子里面加隔板 / 海马 / 好的，2.3，月底交 | 通过 | 无 | 通过 | intent=order；customer=赵姐；product=饰品盒；quantity=800；dueDate=有；remark包含=盒子里面加隔板 | intent=order；operation=；customer=赵姐；product=饰品盒；multi=；quantity=800；unitPrice=2.3；amount=1840；payment=；deposit=；due=2026-07-31；missing=；low=；conflict= |
| 044 | 特殊要求 | 黄老板 / 五金挂件3000个，材质换成不锈钢 / 海马 / 好的，1.5，月底交 | 通过 | 无 | 通过 | intent=order；customer=黄老板；product=五金挂件；quantity=3000；dueDate=有；remark包含=材质换成不锈钢 | intent=order；operation=；customer=黄老板；product=五金挂件；multi=；quantity=3000；unitPrice=1.5；amount=4500；payment=；deposit=；due=2026-07-31；missing=；low=；conflict= |
| 045 | 特殊要求 | 吴总 / 头绳5000条，黑色多一点 / 海马 / 好的，0.35，月底交 | 通过 | 无 | 通过 | intent=order；customer=吴总；product=头绳；quantity=5000；dueDate=有；remark包含=黑色多一点 | intent=order；operation=；customer=吴总；product=头绳；multi=；quantity=5000；unitPrice=0.35；amount=1750；payment=；deposit=；due=2026-07-31；missing=；low=；conflict= |
| 046 | 特殊要求 | 刘总 / 收纳盒600个，尺寸比上次大一点 / 海马 / 好的，7.8，月底交 | 通过 | 无 | 通过 | intent=order；customer=刘总；product=收纳盒；quantity=600；dueDate=有；remark包含=尺寸比上次大一点 | intent=order；operation=；customer=刘总；product=收纳盒；multi=；quantity=600；unitPrice=7.8；amount=4680；payment=；deposit=；due=2026-07-31；missing=；low=；conflict= |
| 047 | 特殊要求 | 马总 / 小夜灯1200个，插头要欧规 / 海马 / 好的，4.6，月底交 | 通过 | 无 | 通过 | intent=order；customer=马总；product=小夜灯；quantity=1200；dueDate=有；remark包含=插头要欧规 | intent=order；operation=；customer=马总；product=小夜灯；multi=；quantity=1200；unitPrice=4.6；amount=5520；payment=；deposit=；due=2026-07-31；missing=；low=；conflict= |
| 048 | 特殊要求 | 何姐 / 贴纸2万张，图案不要裁边 / 海马 / 好的，0.12，月底交 | 通过 | 无 | 通过 | intent=order；customer=何姐；product=贴纸；quantity=20000；dueDate=有；remark包含=图案不要裁边 | intent=order；operation=；customer=何姐；product=贴纸；multi=；quantity=20000；unitPrice=0.12；amount=2400；payment=；deposit=；due=2026-07-31；missing=；low=；conflict= |
| 049 | 收款应收 | 陈总 / 有一笔货款15000，月底结 | 通过 | 无 | 通过 | intent=receivable；customer=陈总；amount=15000 | intent=receivable；operation=；customer=陈总；product=；multi=；quantity=；unitPrice=；amount=15000；payment=；deposit=；due=2026-07-31；missing=；low=；conflict= |
| 050 | 收款应收 | 刘总 / 上次尾款还差5000，下周给 | 通过 | 无 | 通过 | intent=receivable；customer=刘总；amount=5000 | intent=receivable；operation=；customer=刘总；product=；multi=；quantity=；unitPrice=；amount=5000；payment=；deposit=；due=2026-07-08；missing=；low=unitPrice；conflict= |
| 051 | 收款应收 | 老李 / 刚转了3000，还剩2000 | 通过 | 无 | 通过 | intent=payment；customer=老李；paymentAmount=3000 | intent=payment；operation=；customer=老李；product=；multi=；quantity=；unitPrice=；amount=；payment=3000；deposit=；due=；missing=；low=；conflict= |
| 052 | 收款应收 | 周姐 / 已到账8600，微信转的 | 通过 | 无 | 通过 | intent=payment；customer=周姐；paymentAmount=8600 | intent=payment；operation=；customer=周姐；product=；multi=；quantity=；unitPrice=；amount=；payment=8600；deposit=；due=；missing=；low=；conflict= |
| 053 | 收款应收 | 马总 / 杯垫定金收了1000，月底交 | 通过 | 无 | 通过 | intent=payment；customer=马总；paymentAmount=1000 | intent=payment；operation=record_order_deposit；customer=马总；product=；multi=；quantity=；unitPrice=；amount=；payment=1000；deposit=1000；due=2026-07-31；missing=；low=；conflict= |
| 054 | 收款应收 | 王总 / 水杯1000个，先付定金2000，月底交 | 通过 | 无 | 通过 | intent=order；customer=王总；depositAmount=2000 | intent=order；operation=；customer=王总；product=水杯；multi=；quantity=1000；unitPrice=；amount=；payment=2000；deposit=2000；due=2026-07-31；missing=；low=；conflict= |
| 055 | 收款应收 | 黄老板 / 那笔五金挂件尾款12000还没结 | 通过 | 无 | 通过 | intent=receivable；customer=黄老板；amount=12000 | intent=receivable；operation=；customer=黄老板；product=；multi=；quantity=5；unitPrice=；amount=12000；payment=；deposit=；due=；missing=dueDate；low=dueDate；conflict= |
| 056 | 收款应收 | 赵姐 / 饰品盒款付了2300，剩余4600 | 通过 | 无 | 通过 | intent=payment；customer=赵姐；paymentAmount=2300 | intent=payment；operation=；customer=赵姐；product=；multi=；quantity=；unitPrice=；amount=；payment=2300；deposit=；due=；missing=；low=；conflict= |
| 057 | 收款应收 | 吴总 / 头绳一共1750，明天付款 | 通过 | 无 | 通过 | intent=receivable；customer=吴总；amount=1750 | intent=receivable；operation=；customer=吴总；product=；multi=；quantity=1750；unitPrice=；amount=1750；payment=；deposit=；due=2026-07-02；missing=；low=；conflict= |
| 058 | 收款应收 | 何姐 / 贴纸款2400已到账 | 通过 | 无 | 通过 | intent=payment；customer=何姐；paymentAmount=2400 | intent=payment；operation=；customer=何姐；product=；multi=；quantity=；unitPrice=；amount=；payment=2400；deposit=；due=；missing=；low=；conflict= |
| 059 | 收款应收 | 钱总 / 包装袋先收了800，后面还有2000 | 通过 | 无 | 通过 | intent=payment；customer=钱总；paymentAmount=800 | intent=payment；operation=；customer=钱总；product=；multi=；quantity=；unitPrice=；amount=；payment=800；deposit=；due=；missing=；low=dueDate；conflict= |
| 060 | 收款应收 | 孙总 / 老款杯垫挂账800，月底一起结 | 通过 | 无 | 通过 | intent=receivable；customer=孙总；amount=800 | intent=receivable；operation=；customer=孙总；product=；multi=；quantity=；unitPrice=；amount=800；payment=；deposit=；due=2026-07-31；missing=；low=；conflict= |
| 061 | 收款应收 | 郭总 / 今天打款5000，不是3000 | 通过 | 无 | 通过 | intent=payment；customer=郭总；paymentAmount=5000 | intent=payment；operation=；customer=郭总；product=；multi=；quantity=；unitPrice=；amount=；payment=5000；deposit=；due=2026-07-01；missing=；low=；conflict= |
| 062 | 收款应收 | 范姐 / 定金三千，货月底交 | 通过 | 无 | 通过 | intent=payment；customer=范姐；paymentAmount=3000 | intent=payment；operation=record_order_deposit；customer=范姐；product=；multi=；quantity=；unitPrice=；amount=；payment=3000；deposit=3000；due=2026-07-31；missing=；low=；conflict= |
| 063 | 收款应收 | 郑总 / 还有一笔没结，一共一万二 | 通过 | 无 | 通过 | intent=receivable；customer=郑总；amount=12000 | intent=receivable；operation=；customer=郑总；product=；multi=；quantity=12000；unitPrice=；amount=12000；payment=；deposit=；due=；missing=dueDate；low=dueDate；conflict= |
| 064 | 收款应收 | 曹老板 / 上次货款结清了 | 通过 | 无 | 通过 | intent=payment；customer=曹老板 | intent=payment；operation=；customer=曹老板；product=；multi=；quantity=；unitPrice=；amount=；payment=；deposit=；due=；missing=paymentAmount；low=dueDate,unitPrice；conflict= |
| 065 | 更新历史 | 王总 / 那单水杯价格改成25一个 | 通过 | 无 | 通过 | operation=update_order；customer=王总；unitPrice=25 | intent=quotation；operation=update_order；customer=王总；product=水杯；multi=；quantity=；unitPrice=25；amount=；payment=；deposit=；due=；missing=；low=unitPrice；conflict=unitPrice |
| 066 | 更新历史 | 李总 / 钥匙扣那单数量改成2500个 | 通过 | 无 | 通过 | operation=update_order；customer=李总；quantity=2500 | intent=order；operation=update_order；customer=李总；product=钥匙扣；multi=；quantity=2500；unitPrice=；amount=；payment=；deposit=；due=；missing=；low=；conflict= |
| 067 | 更新历史 | 陈老板 / 杯垫交期提前到明天 | 通过 | 无 | 通过 | operation=update_order；customer=陈老板 | intent=order；operation=update_order；customer=陈老板；product=杯垫；multi=；quantity=；unitPrice=；amount=；payment=；deposit=；due=2026-07-02；missing=；low=；conflict= |
| 068 | 更新历史 | 周姐 / 礼品盒延期到下周 | 通过 | 无 | 通过 | operation=update_order；customer=周姐 | intent=order；operation=update_order；customer=周姐；product=礼品盒；multi=；quantity=；unitPrice=；amount=；payment=；deposit=；due=2026-07-08；missing=；low=；conflict= |
| 069 | 更新历史 | 钱总 / 包装袋按上次价格做1万只 | 通过 | 无 | 通过 | intent=order；customer=钱总；quantity=10000 | intent=order；operation=；customer=钱总；product=包装袋；multi=；quantity=10000；unitPrice=；amount=；payment=；deposit=；due=；missing=dueDate；low=unitPrice；conflict= |
| 070 | 更新历史 | 孙总 / 老款杯垫照旧价，补1000个 | 通过 | 无 | 通过 | intent=order；customer=孙总；quantity=1000 | intent=order；operation=；customer=孙总；product=老款杯垫；multi=；quantity=1000；unitPrice=；amount=；payment=；deposit=；due=；missing=dueDate；low=unitPrice；conflict= |
| 071 | 更新历史 | 赵姐 / 饰品盒不要做了 | 通过 | 无 | 通过 | intent=unknown；customer=赵姐 | intent=unknown；operation=；customer=赵姐；product=；multi=；quantity=；unitPrice=；amount=；payment=；deposit=；due=；missing=intent；low=；conflict= |
| 072 | 更新历史 | 黄老板 / 五金挂件上次那笔报价改一下 | 通过 | 无 | 通过 | operation=update_quotation；customer=黄老板 | intent=quotation；operation=update_quotation；customer=黄老板；product=五金挂件、笔；multi=五金挂件+笔；quantity=1；unitPrice=1；amount=1；payment=；deposit=；due=；missing=；low=productName,unitPrice；conflict=unitPrice |
| 073 | 更新历史 | 吴总 / 头绳再来5000条，按上回 | 通过 | 无 | 通过 | intent=order；customer=吴总；quantity=5000 | intent=order；operation=；customer=吴总；product=头绳；multi=；quantity=5000；unitPrice=；amount=；payment=；deposit=；due=；missing=dueDate；low=unitPrice；conflict= |
| 074 | 更新历史 | 刘总 / 收纳盒这单备注一下，箱规改小 | 通过 | 无 | 通过 | operation=update_order；customer=刘总 | intent=order；operation=update_order；customer=刘总；product=收纳盒；multi=；quantity=；unitPrice=；amount=；payment=；deposit=；due=；missing=；low=；conflict= |
| 075 | 更新历史 | 马总 / 小夜灯先别发，等通知 | 通过 | 无 | 通过 | intent=unknown；customer=马总 | intent=unknown；operation=；customer=马总；product=；multi=；quantity=；unitPrice=；amount=；payment=；deposit=；due=；missing=intent；low=；conflict= |
| 076 | 更新历史 | 何姐 / 贴纸价格写错了，不是0.15，是0.12 | 通过 | 无 | 通过 | intent=quotation；customer=何姐；unitPrice=0.12 | intent=quotation；operation=update_quotation；customer=何姐；product=贴纸；multi=；quantity=；unitPrice=0.12；amount=；payment=；deposit=；due=；missing=；low=unitPrice；conflict=unitPrice |
| 077 | 多产品 | 王总 / 你好 / 海马 / 在的 / 王总 / 水杯1000个25一个，杯垫300个9毛，月底一起交 | 通过 | 无 | 通过 | intent=order；customer=王总；multiProducts=水杯+杯垫 | intent=order；operation=；customer=王总；product=水杯、杯垫；multi=水杯+杯垫；quantity=1000；unitPrice=0.9；amount=900；payment=；deposit=；due=2026-07-31；missing=；low=productName；conflict= |
| 078 | 多产品 | 李总 / 你好 / 海马 / 在的 / 李总 / 钥匙扣2000个1.3，包装袋1万只8分，下周发 | 通过 | 无 | 通过 | intent=order；customer=李总；multiProducts=钥匙扣+包装袋 | intent=order；operation=；customer=李总；product=钥匙扣、包装袋；multi=钥匙扣+包装袋；quantity=2000；unitPrice=0.08；amount=160；payment=；deposit=；due=2026-07-08；missing=；low=productName；conflict= |
| 079 | 多产品 | 陈老板 / 你好 / 海马 / 在的 / 陈老板 / 杯垫300个，颜色浅一点；礼品盒500套，logo放大 | 通过 | 无 | 通过 | intent=order；customer=陈老板；multiProducts=杯垫+礼品盒 | intent=order；operation=；customer=陈老板；product=杯垫、礼品盒；multi=杯垫+礼品盒；quantity=300；unitPrice=；amount=；payment=；deposit=；due=；missing=dueDate；low=productName；conflict= |
| 080 | 多产品 | 周姐 / 你好 / 海马 / 在的 / 周姐 / 先问礼品盒500套多少钱，再问收纳盒600个多少钱 | 失败 | intent_error | 意图打分规则被关键词误导，或缺少该类表达规则。 | intent=order；customer=周姐；multiProducts=礼品盒+收纳盒 | intent=quotation；operation=；customer=周姐；product=礼品盒、收纳盒；multi=礼品盒+收纳盒；quantity=500；unitPrice=；amount=；payment=；deposit=；due=；missing=unitPrice；low=productName；conflict= |
| 081 | 多产品 | 钱总 / 你好 / 海马 / 在的 / 钱总 / 包装袋和贴纸一起报，包装袋1万只，贴纸2万张 | 失败 | intent_error | 意图打分规则被关键词误导，或缺少该类表达规则。 | intent=order；customer=钱总；multiProducts=包装袋+贴纸 | intent=quotation；operation=；customer=钱总；product=包装袋、贴纸；multi=包装袋+贴纸；quantity=10000；unitPrice=；amount=；payment=；deposit=；due=；missing=unitPrice；low=productName；conflict= |
| 082 | 多产品 | 孙总 / 你好 / 海马 / 在的 / 孙总 / 老款杯垫1000个，水杯800个，价格照旧 | 通过 | 无 | 通过 | intent=order；customer=孙总；multiProducts=老款杯垫+水杯 | intent=order；operation=；customer=孙总；product=老款杯垫、水杯；multi=老款杯垫+水杯；quantity=1000；unitPrice=；amount=；payment=；deposit=；due=；missing=dueDate；low=productName,unitPrice；conflict= |
| 083 | 多产品 | 赵姐 / 你好 / 海马 / 在的 / 赵姐 / 饰品盒800个2.3，小夜灯1200个4.6 | 通过 | 无 | 通过 | intent=order；customer=赵姐；multiProducts=饰品盒+小夜灯 | intent=order；operation=；customer=赵姐；product=饰品盒、小夜灯；multi=饰品盒+小夜灯；quantity=800；unitPrice=2.3；amount=1840；payment=；deposit=；due=；missing=dueDate；low=productName；conflict= |
| 084 | 多产品 | 黄老板 / 你好 / 海马 / 在的 / 黄老板 / 五金挂件3000个，钥匙扣2000个，周五出 | 通过 | 无 | 通过 | intent=order；customer=黄老板；multiProducts=五金挂件+钥匙扣 | intent=order；operation=；customer=黄老板；product=五金挂件、钥匙扣；multi=五金挂件+钥匙扣；quantity=3000；unitPrice=；amount=；payment=；deposit=；due=2026-07-03；missing=；low=productName；conflict= |
| 085 | 多产品 | 吴总 / 你好 / 海马 / 在的 / 吴总 / 头绳5000条0.35，扣子1000件0.38 | 通过 | 无 | 通过 | intent=order；customer=吴总；multiProducts=头绳+扣子 | intent=order；operation=；customer=吴总；product=头绳、扣子；multi=头绳+扣子；quantity=5000；unitPrice=0.35；amount=1750；payment=；deposit=；due=；missing=dueDate；low=productName；conflict= |
| 086 | 多产品 | 刘总 / 你好 / 海马 / 在的 / 刘总 / 收纳盒600个7.8，箱子500个59 | 通过 | 无 | 通过 | intent=order；customer=刘总；multiProducts=收纳盒+箱子 | intent=order；operation=；customer=刘总；product=收纳盒、箱子；multi=收纳盒+箱子；quantity=600；unitPrice=7.8；amount=4680；payment=；deposit=；due=；missing=dueDate；low=productName；conflict= |
| 087 | 多产品 | 马总 / 你好 / 海马 / 在的 / 马总 / 小夜灯1200个4.6，包装袋5000只0.08 | 通过 | 无 | 通过 | intent=order；customer=马总；multiProducts=小夜灯+包装袋 | intent=order；operation=；customer=马总；product=小夜灯、包装袋；multi=小夜灯+包装袋；quantity=1200；unitPrice=4.6；amount=5520；payment=；deposit=；due=；missing=dueDate；low=productName；conflict= |
| 088 | 多产品 | 何姐 / 你好 / 海马 / 在的 / 何姐 / 贴纸2万张0.12，文具套装200套12块 | 通过 | 无 | 通过 | intent=order；customer=何姐；multiProducts=贴纸+文具套装 | intent=order；operation=；customer=何姐；product=贴纸、文具套装；multi=贴纸+文具套装；quantity=20000；unitPrice=12；amount=240000；payment=；deposit=；due=；missing=dueDate；low=productName；conflict= |
| 089 | 待办 | 王总 / 明天提醒我回复水杯报价 | 通过 | 无 | 通过 | intent=todo；customer=王总；todoTitle=回复王总水杯报价；dueDate=有 | intent=todo；operation=；customer=王总；product=水杯；multi=；quantity=；unitPrice=；amount=；payment=；deposit=；due=2026-07-02；missing=；low=；conflict= |
| 090 | 待办 | 李总 / 后天给他回钥匙扣价格 | 通过 | 无 | 通过 | intent=todo；customer=李总；todoTitle=回复李总钥匙扣报价；dueDate=有 | intent=todo；operation=；customer=李总；product=钥匙扣；multi=；quantity=；unitPrice=；amount=；payment=；deposit=；due=2026-07-03；missing=；low=；conflict= |
| 091 | 待办 | 陈老板 / 下午催一下杯垫尾款 | 失败 | wrong_todo_title | 待办标题生成依赖有限模板，无法覆盖复杂说法。 | intent=todo；customer=陈老板；todoTitle=催陈老板货款；dueDate=有 | intent=todo；operation=；customer=陈老板；product=杯垫；multi=；quantity=；unitPrice=；amount=；payment=；deposit=；due=2026-07-01；missing=；low=；conflict= |
| 092 | 待办 | 周姐 / 明天跟进礼品盒确认没 | 通过 | 无 | 通过 | intent=todo；customer=周姐；todoTitle=跟进周姐礼品盒；dueDate=有 | intent=todo；operation=；customer=周姐；product=礼品盒；multi=；quantity=；unitPrice=；amount=；payment=；deposit=；due=2026-07-02；missing=；low=；conflict= |
| 093 | 待办 | 钱总 / 下周联系包装袋样品 | 通过 | 无 | 通过 | intent=todo；customer=钱总；todoTitle=联系包装袋样品；dueDate=有 | intent=todo；operation=；customer=钱总；product=包装袋；multi=；quantity=；unitPrice=；amount=；payment=；deposit=；due=2026-07-08；missing=；low=；conflict= |
| 094 | 待办 | 孙总 / 月底催老款杯垫货款 | 通过 | 无 | 通过 | intent=todo；customer=孙总；todoTitle=催孙总货款；dueDate=有 | intent=todo；operation=；customer=孙总；product=老款杯垫；multi=；quantity=；unitPrice=；amount=；payment=；deposit=；due=2026-07-31；missing=；low=；conflict= |
| 095 | 待办 | 赵姐 / 明天问饰品盒数量 | 通过 | 无 | 通过 | intent=todo；customer=赵姐；todoTitle=跟进赵姐饰品盒；dueDate=有 | intent=todo；operation=；customer=赵姐；product=饰品盒；multi=；quantity=；unitPrice=；amount=；payment=；deposit=；due=2026-07-02；missing=；low=；conflict= |
| 096 | 待办 | 黄老板 / 后天发五金挂件对账单 | 通过 | 无 | 通过 | intent=todo；customer=黄老板；todoTitle=发五金挂件对账单；dueDate=有 | intent=todo；operation=；customer=黄老板；product=五金挂件；multi=；quantity=；unitPrice=；amount=；payment=；deposit=；due=2026-07-03；missing=；low=；conflict= |
| 097 | 待办 | 吴总 / 今天回头绳单价 | 通过 | 无 | 通过 | intent=todo；customer=吴总；todoTitle=回复吴总头绳报价；dueDate=有 | intent=todo；operation=；customer=吴总；product=头绳；multi=；quantity=；unitPrice=；amount=；payment=；deposit=；due=2026-07-01；missing=；low=；conflict= |
| 098 | 待办 | 刘总 / 明天确认收纳盒颜色 | 通过 | 无 | 通过 | intent=todo；customer=刘总；todoTitle=确认收纳盒颜色；dueDate=有 | intent=todo；operation=；customer=刘总；product=收纳盒；multi=；quantity=；unitPrice=；amount=；payment=；deposit=；due=2026-07-02；missing=；low=；conflict= |
| 099 | 待办 | 马总 / 周五提醒我看小夜灯进度 | 通过 | 无 | 通过 | intent=todo；customer=马总；todoTitle=看小夜灯进度；dueDate=有 | intent=todo；operation=；customer=马总；product=小夜灯；multi=；quantity=；unitPrice=；amount=；payment=；deposit=；due=2026-07-03；missing=；low=；conflict= |
| 100 | 待办 | 何姐 / 后天跟进贴纸报价 | 通过 | 无 | 通过 | intent=todo；customer=何姐；todoTitle=跟进何姐贴纸；dueDate=有 | intent=todo；operation=；customer=何姐；product=贴纸；multi=；quantity=；unitPrice=；amount=；payment=；deposit=；due=2026-07-03；missing=；low=；conflict= |

## 建议优先级

1. 先解决高频字段错误：产品、单价、金额、待办标题，这些直接影响确认卡可用性。
2. 对多产品聊天新增“拆多条草稿”能力；如果本地不能拆，必须提示用户或交给 AI。
3. 本地继续保留“安全拦截”边界：有多个价格/数量候选时不要直接保存，除非 AI 返回明确 `superseded_facts`。
4. 真机要接通 AI，必须把 `apiBaseUrl` 换成合法 HTTPS 域名，并在微信公众平台配置 request 合法域名。
