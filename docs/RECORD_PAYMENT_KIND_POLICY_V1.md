# 待收款收款类型余额合同 V1

## 1. 产品结论

用户确认关联一笔当前有效待收款后，`record_payment` 的最终 `kind` 只能由保存时绑定的
待收款余额决定：

```text
本次收款 < 保存前剩余余额  → partial_payment（部分收款）
本次收款 = 保存前剩余余额  → final_payment（最后一笔/收清）
本次收款 > 保存前剩余余额  → 拒绝保存
```

`orderId` 只表达订单关系，不能证明已经收清。AI、Fixture、页面或调用方传入的
`paymentKind/kind` 也不能覆盖保存层的余额裁定。

## 2. 金额与失败边界

统一纯函数 `utils/payment-kind.js` 先按现有两位小数规则转为整数分，再比较本次收款和
剩余余额。它拒绝非数字、零、负数、已结清、脏余额和超额收款，并返回结构化错误；
不会读取页面、AI、Storage或原文。

保存层在写入前重新读取或绑定当前余额。部分收款同步写入`partial_payment`、增加一次
`paidAmount`并保持“部分收款”；正好结清写入`final_payment`、余额归零并标记“已结清”。
任何分类错误都必须在payment、receivable、parse log、revision和receipt变化前失败。

## 3. 三条保存路径

- Legacy：`savePayment → recordPayment`读取当前Legacy State，分类后在同一受控事务中
  创建payment并更新receivable。
- Shared SavePlan：Plan以State snapshot计算分类；CAS保证旧余额Plan不能提交。exact
  replay不重复，stale plan拒绝，失败注入全部回滚。Shared生产Commit仍关闭。
- Server镜像：使用独立部署可加载的同合同纯函数镜像，不信任客户端kind。当前只完成
  离线业务/合同测试，不代表已连接真实数据库或真实服务事务。

`utils/record-domain-preflight.js`只机械复用同一整数分余额算法，修正`0.30-0.10`一类
精度比较；既有Preflight政策、错误码和阻断语义没有改变。

## 4. 兼容合同

- 可信内部订单定金仍写`deposit`，普通调用不能伪造定金用途。
- 未关联普通收款和未关联定金继续使用既有`unlinked_payment`、
  `unlinked_deposit`合同。
- 历史`payment`、`receivable_payment`和`legacy_payment`继续可读、可显示，不做迁移。
- 新保存且确认关联当前待收款的`record_payment`不再生成历史kind。
- `partial_payment`在金融列表、首页工作台和详情中显示为“部分收款”。

## 5. 目标Case

| Case | 保存前已收/剩余 | 本次收款 | 保存后已收/剩余 | kind | 结果 |
| --- | --- | ---: | --- | --- | --- |
| FIN-001 | 1000 / 4000 | 1600 | 2600 / 2400 | `partial_payment` | PASS |
| FIN-013 | 1000 / 4000 | 1000 | 2000 / 3000 | `partial_payment` | PASS；重启一致 |
| FIN-014 | 1000 / 4000 | 600 | 1600 / 3400 | `partial_payment` | PASS；第二触发被抑制 |
| BASIC-011 | 1000 / 4000 | 1500 | 2500 / 2500 | `partial_payment` | PASS |
| VOICE-010 | 1000 / 4000 | 1500 | 2500 / 2500 | `partial_payment` | PASS |

三条FIN Case继续使用Fake Deep AI，生产页面因Fake Provider保持`BLOCKED`且不写入；
测试隔离Legacy Lane验证真实保存语义。五条收款均`aiParseLogs=1`、
`operationLogs=0`。

## 6. 离线验证结果

专项覆盖partial、exact final、overpayment、0/负数、0.01、两位小数、`0.1+0.2`、
Legacy/Shared/server一致性、定金伪造保护、历史显示、CAS、exact replay、stale plan和
失败回滚。最终120题双轮结果：

```text
ACTIVE        120
Executed      120
PASS           25
CASE_FAIL      95
RUNNER_ERROR    0
BLOCKED         0
SURFACE_ERROR   0
```

双轮确定性稳定；54条P0失败全部单题重跑，P1分层抽查11条；
`TEST_ONLY_ISOLATED_LEGACY_COMMIT=88`。两轮
`duplicatePaymentCommitCount`、`paymentKindBalanceMismatchCount`、
`overpaymentCommitCount`、网络、真实Storage、Fixture mutation、Parser Graph、
Journal和Backup全部为0。

这不是微信WXML/真机、真实千问或真实server数据库验证，不构成发布结论。
