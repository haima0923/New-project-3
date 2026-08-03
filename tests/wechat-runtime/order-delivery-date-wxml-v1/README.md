# 普通订单交期真实 WXML 渲染门禁 V1

本门禁只验证微信开发者工具真实编译、运行和渲染后的确认卡交期，不保存订单，不操作日期控件，也不向页面直接写入 `dueDate`。

运行前提：

- 微信开发者工具已安装；
- “设置 → 安全设置 → 服务端口”已开启；
- 当前项目能够通过微信开发者工具正常编译。

运行：

```bash
pnpm test:wechat-order-date
```

开发者工具保留内部 `__dev__` 场景时，可先关闭当前项目，再按案例隔离运行；脚本会核对最终 route，内部测试页不能冒充目标页面：

```bash
WECHAT_CASE_IDS=CASE-D pnpm test:wechat-order-date
WECHAT_CASE_IDS=CASE-E pnpm test:wechat-order-date
```

脚本通过 `miniprogram-automator` 从当前仓库路径为每个案例分别启动、连接并关闭一个新的微信开发者工具自动化实例，避免复用来源不明的旧页面或页面句柄，并运行：

- Case A：首页快速入口；
- Case B：完整“记一笔”页面；
- Case C：无空格控制组的首页入口；
- Case D：普通空格失败组的首页入口；
- Case E：普通空格失败组的完整页入口。

普通空格案例必须由原始输入自然经过 Parser、Hybrid 和页面确认态，不得操作日期控件、直接写入 `dueDate` 或由 fixture 预填日期。任一案例不是 `R1` 时脚本以失败状态退出。

结构化报告和截图输出到已忽略的
`output/wechat-runtime/order-delivery-date-wxml-v1/`，不进入测试合同提交。报告同时记录
Git 身份、源码 SHA-256 哈希、页面 data、真实 WXML 元素、位置尺寸和截图路径。

在冻结提交或生产修复分支复跑时，应显式传入该次运行的 Git 身份，防止连接旧运行包：

```bash
WECHAT_EXPECTED_BRANCH=fix/order-delivery-date-whitespace-v1 \
WECHAT_EXPECTED_HEAD=<当前完整SHA> \
pnpm test:wechat-order-date
```

结果分类：

- `R1`：页面 data 和真实渲染都正确；
- `R2`：页面 data 正确，真实渲染错误；
- `R3`：Parser 有日期，但页面 data 为空；
- `R4`：真实运行时 Parser 没有日期；
- `R5`：运行包身份无法证明。

失败优先冻结证据（修复前）：Case D、Case E 都为 `R4`，Parser 日期、页面日期和 picker value 均为空，交期元素真实显示待选择文案。

最小生产修复后：Case B、Case C 两个无空格控制入口以及 Case D、Case E 两个普通空格入口均为 `R1`，Parser、页面 data、可见交期文本和 picker value 都是 `2026-08-15`。
