# 测试与回归能力盘点

本文件作为“测试与回归 Agent”盘点结果，只基于当前真实代码和现有测试资料记录。本轮未运行测试、未修改测试脚本、未修改业务代码。

## 1. 总体判断

当前项目已经有一定测试基础，主要集中在三类：

- `scripts/core-feature-tests.js`：覆盖解析、问一句、保存业务记录、客户合并、首页工作台、财务/定金等核心逻辑。
- `scripts/evaluate-wechat-local-rules*.js`：离线评测微信聊天复制文本的本地规则解析能力，并生成历史报告。
- `promptfoo/`：包含“记一笔”和“问一句”的本地 mock 100 条回归用例，通过本地 server 的 `/api/ai/parse` 和 `/api/ai/query` 接口评测。

当前测试体系的主要优点：

- 有本地规则解析专项测试。
- 有固定 100 条“记一笔”用例。
- 有固定 100 条“问一句”用例。
- 有核心业务链路的 Node 断言测试。
- 有历史 HTML / MD / TXT 报告留存。

主要风险：

- 历史报告不一定代表当前代码。
- promptfoo 用例依赖本地 mock server，不代表真实大模型效果。
- 固定 100 条用例存在过拟合风险。
- 没有小程序 UI 自动化测试。
- 缺少真实义乌工厂老板样本和隐藏测试集。
- 缺少每次修改 parser / business / storage 后强制执行的统一回归入口。
- 业务端到端链路仍不够完整，尤其是报价转订单、订单生成应收款、部分收款、结清、催款、客户自动关联的组合验证。

## 2. 可运行测试脚本清单

### `scripts/core-feature-tests.js`

类型：

- Node 本地断言脚本。

主要依赖：

- Node.js。
- 直接 `require` 前端工具模块。
- 不依赖 promptfoo。
- 不依赖真实 API。

覆盖内容：

- 记一笔核心解析样例。
- 本地解析安全门控。
- 粘贴微信聊天提取。
- 问一句核心样例。
- AI 请求上下文策略。
- 展示文案工具。
- 待办保存。
- 客户重名与合并。
- 输入页客户历史提示。
- 报价跟进时间。
- 订单/报价筛选。
- 导航状态。
- 待办页面数据。
- 首页工作台数据。
- 财务页面和定金数据。
- 远程 AI 合并保护。
- 高置信本地解析跳过远程。
- 微信多轮 AI 路由与冲突保护。
- 历史缺失和默认带出。

可运行性判断：

- 理论上可直接运行：`node scripts/core-feature-tests.js`
- 本轮未实际执行。

### `scripts/evaluate-wechat-local-rules.js`

类型：

- Node 离线评测脚本。

主要依赖：

- Node.js。
- `utils/clipboard-chat.js`
- `utils/ai-parser.js`

测试对象：

- 微信聊天复制文本。
- 本地链路：`analyzeClipboardText -> parseHybridInput`

输出：

- 写入 `docs/wechat-local-rules-evaluation.md`

可运行性判断：

- 可运行，但会修改历史报告文件。
- 本轮禁止修改该报告，因此未运行。

### `scripts/evaluate-wechat-local-rules-hard.js`

类型：

- Node 离线高难度评测脚本。

测试对象：

- 更复杂的微信聊天文本。
- 多轮、噪声、错别字、数字大小写、意图干扰等。

输出：

- `docs/wechat-local-rules-hard-evaluation.md`
- `docs/wechat-local-rules-hard-evaluation.html`
- `docs/wechat-local-rules-hard-evaluation.txt`

可运行性判断：

- 可运行，但会修改历史报告文件。
- 本轮未运行。

### `scripts/evaluate-wechat-local-rules-ultra.js`

类型：

- Node 离线升级难度评测脚本。

测试对象：

- 图片/语音转文字描述、代发客户、群聊、自我记录、错别字、撤回、取消、改价、改量、备注覆盖、部分收款、多产品拆单等复杂场景。

输出：

- `docs/wechat-local-rules-ultra-evaluation.md`
- `docs/wechat-local-rules-ultra-evaluation.html`
- `docs/wechat-local-rules-ultra-evaluation.txt`
- 还会写根目录同名报告文件。

可运行性判断：

- 可运行，但会修改多个报告文件。
- 本轮未运行。

### `scripts/export-wechat-local-rules-report.js`

类型：

- 报告导出脚本。

作用：

- 读取 `docs/wechat-local-rules-evaluation.md`。
- 生成 `docs/wechat-local-rules-evaluation.html` 和 `docs/wechat-local-rules-evaluation.txt`。

可运行性判断：

- 可运行，但会修改报告文件。
- 不属于测试本体，更像报告转换工具。

### `scripts/run-promptfoo-record-local.ps1`

类型：

- PowerShell promptfoo 封装脚本。

测试对象：

- 记一笔 100 条回归。

主要行为：

- 检查或启动本地 mock server：`server/src/server.js`
- 设置：
  - `PORT=3001`
  - `AI_PROVIDER=mock`
  - `AI_API_KEY=`
  - `AI_BASE_URL=`
  - `AI_MODEL=`
- 使用 `promptfoo eval`。
- 如果本机没有 `promptfoo` 命令，会走 `npm exec --package promptfoo@latest`。
- 生成 promptfoo 结果和中文报告。

输出：

- `reports/promptfoo-record/record-results.json`
- `reports/promptfoo-record/record-report.html`
- CSV 明细。
- `temp/promptfoo/` 缓存目录。

依赖：

- PowerShell。
- Node.js。
- npm。
- promptfoo 或可联网下载 promptfoo。
- 本地 server 可启动。

可运行性判断：

- 可运行，但会创建或修改 `reports/`、`temp/`。
- 如果没有 promptfoo 且不能联网，可能失败。
- 本轮未运行。

### `scripts/run-promptfoo-query-local.ps1`

类型：

- PowerShell promptfoo 封装脚本。

测试对象：

- 问一句 smoke 或 full 回归。

参数：

- `-Suite smoke`：使用 `promptfoo/query-local.yaml`
- `-Suite full`：使用 `promptfoo/query-full.yaml`

主要行为：

- 检查或启动本地 mock server。
- 使用 `promptfoo eval`。
- full 模式会生成结果和报告。

依赖：

- PowerShell。
- Node.js。
- npm。
- promptfoo 或可联网下载 promptfoo。
- 本地 server 可启动。

可运行性判断：

- smoke 可作为较轻量检查。
- full 会生成报告文件。
- 本轮未运行。

### `scripts/build-promptfoo-record-report.js`

类型：

- promptfoo 结果报告生成脚本。

作用：

- 读取 promptfoo record 结果 JSON 和 `record-cases-100.json`。
- 生成中文 HTML 和 CSV 明细。

依赖：

- 已存在 promptfoo 结果文件。

可运行性判断：

- 不是独立测试，只是报告构建工具。

### `scripts/build-promptfoo-query-report.js`

类型：

- promptfoo 结果报告生成脚本。

作用：

- 读取 promptfoo query 结果 JSON 和 `query-cases-100.json`。
- 生成中文 HTML 和 CSV 明细。

依赖：

- 已存在 promptfoo 结果文件。

可运行性判断：

- 不是独立测试，只是报告构建工具。

### `scripts/ai-contract-smoke.js`

类型：

- API 合同冒烟测试。

测试对象：

- `/api/ai/parse`
- `/api/ai/query`

默认地址：

- `https://api.baizeji.com`

可通过环境变量覆盖：

- `API_BASE_URL`

依赖：

- Node.js。
- 可访问的 API 服务。
- 如果使用默认地址，则依赖外部网络和线上服务。

可运行性判断：

- 可运行，但不是纯本地测试。
- 不适合作为每次本地改 parser 后的最低必跑项。

## 3. promptfoo 测试清单

### `promptfoo/record-full.yaml`

用途：

- 记一笔本地 mock 100 条回归。

provider：

- `file://./providers/local-record.js`

接口：

- `POST http://127.0.0.1:3001/api/ai/parse`

测试数据：

- `promptfoo/record-cases-100.json`

断言重点：

- 返回 JSON。
- `provider` 必须是 `mock`。
- `intent`。
- `operation`。
- `customerName`。
- `productName`。
- `todoTitle`。
- `quantity`。
- `unitPrice`。
- `amount`。
- `paymentAmount`。
- `remainingAmount`。
- `dueDate`。
- `missing_fields`。
- `low_confidence_fields`。

可复跑性：

- 可复跑。
- 依赖本地 mock server。
- 不直接依赖真实大模型。

### `promptfoo/record-cases-100.json`

用途：

- 记一笔固定 100 条用例。

分类统计：

- 报价：15
- 订单：15
- 应收：12
- 收款：12
- 待办：10
- 历史/返单：10
- 修改/补充：10
- 缺字段/待整理：8
- 粘贴聊天：8

覆盖判断：

- 覆盖了报价、订单、应收款、收款、待办、历史返单、修改补充、缺字段待整理、粘贴聊天。
- 没有明显看到单独分类为“催款”的 100 条 promptfoo 记一笔用例。
- 订单定金在 `core-feature-tests.js` 中有覆盖，promptfoo 固定分类中未单独列为“订单定金”。

### `promptfoo/query-full.yaml`

用途：

- 问一句本地 mock 100 条回归。

provider：

- `file://./providers/local-query.js`

接口：

- `POST http://127.0.0.1:3001/api/ai/query`

测试数据：

- `promptfoo/query-cases-100.json`

断言重点：

- 返回 JSON。
- `title`。
- `lines`。
- `readonly: true`。
- `provider: mock`。
- 不应触发兜底回复。
- 包含预期关键词。
- 排除不该出现的关键词。

可复跑性：

- 可复跑。
- 依赖本地 mock server。
- 不直接依赖真实大模型。

### `promptfoo/query-local.yaml`

用途：

- 问一句 smoke 测试。

用例数量：

- 内联 10 条。

覆盖方向：

- 欠款总览。
- 单个客户欠款。
- 月底前收款。
- 近期交货。
- 订单状态。
- 上次报价。
- 未转订单报价。
- 今天事项。
- 明天待办。
- 待整理记录。

可复跑性：

- 可复跑。
- 比 full 更适合作为快速 smoke。

### `promptfoo/query-cases-100.json`

用途：

- 问一句固定 100 条用例。

分类统计：

- 欠款总览：10
- 单客户欠款：10
- 近期收款：10
- 近期交货：10
- 订单状态：10
- 上次报价：10
- 待跟进报价：10
- 今天事项：10
- 明天待办：10
- 待整理记录：10

覆盖判断：

- 覆盖欠款查询、交期查询、报价查询、客户历史报价、今天/明天事项。
- 没有明显看到“本周”“本月”作为独立分类；近期收款和近期交货可能覆盖一部分时间范围，但需要补充明确的本周/本月/今天边界用例。

### `promptfoo/providers/local-record.js`

作用：

- promptfoo provider。
- 调用本地 `/api/ai/parse`。
- 默认 `baseUrl` 为 `http://127.0.0.1:3001`。

### `promptfoo/providers/local-query.js`

作用：

- promptfoo provider。
- 内置一份 mock 业务状态。
- 调用本地 `/api/ai/query`。
- 默认 `baseUrl` 为 `http://127.0.0.1:3001`。

风险：

- provider 内置 mock 数据，不等于用户真实数据。
- mock 结果不能代表真实线上 AI 效果。

## 4. 历史测试报告清单

### `docs/wechat-local-rules-evaluation.md`

类型：

- Markdown 历史报告。

生成时间：

- 文件内容显示为 2026-07-01。

结果：

- 总用例：100
- 通过：97
- 失败：3
- 通过率：97.0%

说明：

- 报告声明链路为 `analyzeClipboardText -> parseHybridInput`。
- Node 环境没有 `wx` 和 API endpoint，因此不调用真实 AI。
- 失败集中在多产品、待办等复杂场景。

风险：

- 只能代表生成时的代码状态。
- 不能代表当前代码一定仍是 97%。

### `docs/wechat-local-rules-evaluation.txt`

类型：

- TXT 历史报告。

结果：

- 总用例：100
- 通过：100
- 失败：0
- 通过率：100.0%

风险：

- 与同名 Markdown 报告结果不一致。
- 需要确认哪个文件是最新有效版本，不能直接引用为当前结论。

### `docs/wechat-local-rules-evaluation.html`

类型：

- HTML 历史报告。

说明：

- 由报告导出脚本生成。
- 需要结合 MD/TXT 判断版本。

### `docs/wechat-local-rules-hard-evaluation.md`

类型：

- Markdown 高难度历史报告。

生成时间：

- 文件内容显示为 2026-07-01。

结果：

- 总用例：100
- 通过：97
- 失败：3
- 通过率：97.0%

失败方向：

- 多产品。
- 待办标题。
- 复杂噪声下意图误判。

### `docs/wechat-local-rules-hard-evaluation.txt`

类型：

- TXT 高难度历史报告。

结果：

- 总用例：100
- 通过：97
- 失败：3
- 通过率：97.0%

### `docs/wechat-local-rules-hard-evaluation.html`

类型：

- HTML 高难度历史报告。

说明：

- 与 hard MD/TXT 同系列。

### `docs/wechat-local-rules-ultra-evaluation.md`

类型：

- Markdown 升级难度历史报告。

生成时间：

- 文件内容显示为 2026-07-02。

结果：

- 总用例：100
- 通过：100
- 失败：0
- 通过率：100.0%

覆盖方向：

- 报价升级。
- 订单交期升级。
- 改价改量升级。
- 备注升级。
- 收款应收升级。
- 更新取消升级。
- 多产品升级。
- 待办升级。
- 无效否定升级。
- 客户识别升级。

风险：

- 固定集全部通过不等于真实老板输入全部可靠。
- 仍是本地规则链路，不调用真实 AI。

### `docs/wechat-local-rules-ultra-evaluation.txt`

类型：

- TXT 升级难度历史报告。

结果：

- 总用例：100
- 通过：100
- 失败：0
- 通过率：100.0%

### `docs/wechat-local-rules-ultra-evaluation.html`

类型：

- HTML 升级难度历史报告。

说明：

- 与 ultra MD/TXT 同系列。

### `docs/local-parse-safety-acceptance-report.txt`

类型：

- 本地解析安全门控验收报告。

报告日期：

- 文件内容显示为 2026-07-02。

结果摘录：

- 核心功能回归：全部通过。
- 本地解析安全门控专项测试：5/5 通过。
- 微信升级难度 100 题：100/100 通过，失败 0。
- 前端/服务端解析文件语法检查：通过。

风险：

- 是历史验收结论。
- 不能代替当前复跑。

### `docs/local-parse-safety-acceptance-report.html`

类型：

- HTML 验收报告。

说明：

- 与 TXT 验收报告同系列。

## 5. 记一笔测试覆盖

### 已覆盖

当前已有覆盖：

- 报价。
- 订单。
- 应收款。
- 收款。
- 待办提醒。
- 缺字段进入待整理。
- 粘贴微信聊天。
- 历史/返单。
- 修改/补充。
- 多轮微信聊天。
- 改价、改量、备注。
- 客户识别。
- 本地解析安全门控。
- 订单定金和财务抵扣，在 `core-feature-tests.js` 中有覆盖。

### 字段覆盖

当前测试已覆盖或部分覆盖：

- 客户名。
- 商品。
- 数量。
- 单价。
- 总价。
- 交期。
- 应收日期。
- 收款金额。
- 定金金额。
- 剩余金额。
- 备注。
- 原始文本。
- 缺字段。
- 低置信字段。
- 冲突字段。

### 异常输入覆盖

已有一定覆盖：

- 无效/否定输入。
- 取消。
- 暂停。
- 撤回。
- 图片干扰。
- 错别字。
- 音同字。
- 数字大小写。
- 多产品。
- 群聊。
- 代发客户。
- 自我记录。

### 缺口

仍需补充：

- 催款作为“记一笔”输入的独立测试。
- 真实老板长聊天样本。
- 多客户同名、手机号缺失、公司名混用场景。
- 定金补录发生在已生成应收款之后的边界。
- 超额收款和已结清后继续收款。
- 多产品拆单后的保存链路验证。
- parser 结果进入 `saveConfirmedDraft()` 后的端到端持久化验证。

## 6. 问一句测试覆盖

### 已覆盖

当前已有覆盖：

- 欠款总览。
- 单客户欠款。
- 近期收款。
- 近期交货。
- 订单状态。
- 上次报价。
- 待跟进报价。
- 今天事项。
- 明天待办。
- 待整理记录。

### 与需求对应

- 欠款查询：已覆盖。
- 交期查询：已覆盖近期交货。
- 报价查询：已覆盖上次报价、待跟进报价。
- 客户历史报价：已覆盖上次报价。
- 今天范围：已覆盖今天事项。
- 本周、本月范围：未看到独立分类，需要补充明确边界。

### 缺口

- 本周、本月、月底前、今天/昨天/明天的时间边界需要更系统。
- 多客户同名查询。
- 客户简称查询。
- 已结清与未结清混合时的排除逻辑。
- 定金、尾款、部分收款的问一句。
- 订单状态和财务状态混合问法。
- 数据为空时的回答质量。
- 真实用户口语问法样本。

## 7. 业务流转测试覆盖

### 已覆盖

`core-feature-tests.js` 中覆盖了部分业务流转：

- `saveConfirmedDraft()` 保存订单、应收款、收款、待办等。
- 客户自动创建和重复客户处理。
- 客户合并后关联记录迁移。
- 报价跟进时间计算。
- 首页今日任务聚合。
- 订单定金保存。
- 定金影响生产结算金额。
- 订单生成应收款。
- 定金关联到生成后的应收款。
- 部分收款。
- 结清。
- 财务视图统计。
- 历史应收保存。

### 不足

缺少更明确的端到端场景：

- 报价转订单完整链路。
- 报价转订单后防重复转换。
- 订单生成应收款后订单页面和财务页面一致性。
- 应收款页面手动收款的超额保护。
- 已结清应收款继续收款保护。
- 催款话术生成、复制、记录、再次催款计数。
- 删除或修改记录后的关联同步。
- 客户档案与报价、订单、应收款、收款的完整自动关联链路。
- 小程序页面真实点击路径下的数据一致性。

## 8. UI 人工验证能力

### 自动化 UI 测试现状

当前未发现专门的小程序 UI 自动化测试。

未看到：

- 微信开发者工具自动化脚本。
- 小程序 e2e 测试。
- Playwright / miniprogram 自动点击测试。
- 截图回归测试。

因此当前 UI 只能人工验证。

### 关键人工验证路径

建议人工验证以下路径：

- 首次打开首页：无数据空状态是否真实、无假客户/假金额。
- 记一笔输入报价：输入文本 -> 确认卡 -> 保存 -> 报价列表出现。
- 报价转订单：报价列表 -> 转订单 -> 订单列表出现 -> 报价状态变化。
- 记一笔输入订单：确认卡 -> 保存 -> 订单列表 -> 首页临近交期。
- 订单生成应收款：订单列表 -> 生成应收款 -> 财务/应收款页面出现。
- 记一笔输入应收款：保存后首页待收款、财务页、客户档案联动。
- 收款：财务页部分收款 -> 剩余金额变化 -> 再收款结清 -> 状态变化。
- 应收款页面收款：重点验证是否允许超额收款和已结清后继续收款。
- 催款：逾期应收款 -> 复制催款话术 -> 记录已催 -> 催款次数变化。
- 定金：订单带定金 -> 财务生产结算金额减少 -> 生成应收款后定金抵扣。
- 客户档案：新客户自动创建 -> 业务记录归到该客户 -> 同名客户处理。
- 待整理：无法识别或缺字段输入 -> 进入待整理 -> 待整理页面可查看。
- 问一句：问欠款、交期、报价、今天事项、待整理。
- 自定义底部导航：各入口跳转是否正确。

## 9. 当前测试缺口

当前缺口包括：

- 没有统一的“一键最低回归”脚本。
- 没有 CI 或提交前强制回归规则。
- 没有小程序 UI 自动化。
- 没有真实老板样本库。
- 没有隐藏测试集。
- 没有线上 AI 和本地 mock 的差异评测。
- 没有 parser 修改后的必跑清单。
- 没有 business/storage 修改后的必跑业务链路测试。
- 没有业务数据迁移测试。
- 没有异常重复提交测试。
- 没有超额收款和已结清后收款的明确回归。
- 没有催款链路的完整回归。
- 没有跨页面一致性自动验证。

## 10. 高风险测试问题

### 历史报告和当前代码可能不一致

历史报告是某次运行的产物，不会随代码自动更新。

尤其是：

- `docs/wechat-local-rules-evaluation.md` 显示 97%。
- `docs/wechat-local-rules-evaluation.txt` 显示 100%。

同名系列结果不一致，说明不能直接把报告当作当前代码结论。

### 固定 100 条测试有过拟合风险

固定用例会带来风险：

- 规则可能专门适配这些表达。
- 新的真实聊天说法没有覆盖。
- 100/100 通过不代表泛化能力足够。

### 缺少真实老板样本

当前用例覆盖很多构造场景，但仍缺少来自真实义乌工厂老板的匿名样本。

风险：

- 实际表达更短、更乱、更省略。
- 客户、商品、金额、交期可能分散在多轮聊天。
- 老板可能粘贴群聊、图片说明、语音转文字错字。

### 缺少隐藏测试集

没有看到不可见测试集或保留集。

风险：

- parser 修改后容易只对公开固定集调优。

### 缺少 parser 必跑回归

目前没有统一规则要求修改以下文件后必须跑哪些测试：

- `utils/parser.js`
- `utils/ai-parser.js`
- `utils/parse-safety.js`
- `utils/text-normalize.js`
- `server/utils/parser.js`
- `server/utils/ai-parser.js`

### 缺少业务链路端到端测试

业务链路测试有基础，但还不够端到端。

高风险链路：

- 报价 -> 订单 -> 应收款 -> 收款 -> 催款。
- 订单定金 -> 应收款抵扣 -> 尾款结清。
- 客户自动创建 -> 记录关联 -> 客户合并。
- 首页看板 -> 列表页 -> 详情/操作页。

## 11. 推荐最低回归测试命令

以下是后续修改后建议执行的最低命令清单，本轮未执行。

### parser / AI 解析相关修改后

```powershell
node scripts/core-feature-tests.js
node scripts/evaluate-wechat-local-rules-ultra.js
```

说明：

- 第一条覆盖核心功能。
- 第二条会更新历史报告文件，适合在允许修改报告的测试轮次运行。

### 问一句相关修改后

```powershell
node scripts/core-feature-tests.js
.\scripts\run-promptfoo-query-local.ps1 -Suite smoke
```

说明：

- smoke 不使用 100 条 full 报告输出，适合快速检查。
- 仍会启动本地 mock server，并可能写入 `temp/`。

### 完整本地 mock 回归

```powershell
node scripts/core-feature-tests.js
.\scripts\run-promptfoo-record-local.ps1
.\scripts\run-promptfoo-query-local.ps1 -Suite full
```

说明：

- 会写入 `reports/` 和 `temp/`。
- 如果没有 promptfoo，可能通过 npm 下载 promptfoo。

### API 合同冒烟

```powershell
$env:API_BASE_URL='http://127.0.0.1:3001'
node scripts/ai-contract-smoke.js
```

说明：

- 适合本地 server 已启动时检查 API 返回结构。
- 不建议默认打线上 `https://api.baizeji.com` 作为本地最低回归。

## 12. 推荐人工验收路径

推荐按以下顺序人工验收：

1. 空状态：首页、报价、订单、财务、客户、待整理都不能出现假数据。
2. 记一笔报价：保存后报价列表、客户档案、首页跟进是否一致。
3. 报价转订单：状态是否变化，是否能重复转订单。
4. 记一笔订单：订单字段、交期、客户关联是否正确。
5. 订单定金：定金是否挂订单，财务待结算是否扣减。
6. 订单生成应收款：应收金额、已收金额、状态、定金关联是否正确。
7. 部分收款：剩余金额和状态是否正确。
8. 结清：应收款是否从待收/逾期列表移除。
9. 超额收款：财务页和应收款页都要验证是否阻止。
10. 催款：复制话术、记录已催、催款次数、最后催款日期。
11. 问一句：欠款、交期、报价、客户历史、今天事项。
12. 客户档案：自动创建、同名客户、合并客户、业务记录归属。
13. 待整理：缺字段、无法识别、多客户不确定是否进入待整理。
14. 真机预览：底部导航、输入框、确认卡、列表滚动、按钮点击。

## 13. 后续建议补测试顺序

建议顺序：

1. 新增统一最低回归入口，先串起 `core-feature-tests.js`。
2. 补齐收款核销测试：部分收款、结清、超额、已结清后继续收款。
3. 补齐报价转订单幂等测试。
4. 补齐订单生成应收款和定金抵扣端到端测试。
5. 补齐催款话术和催款记录测试。
6. 补齐客户自动创建、同名客户、客户合并后的业务记录一致性测试。
7. 补齐问一句时间范围测试：今天、本周、本月、月底前、逾期。
8. 建立真实老板匿名样本集。
9. 建立隐藏测试集。
10. 设计小程序 UI 人工验收清单或自动化方案。

## 14. 哪些测试可以并行补

以下测试可以多 Agent 并行补充：

- 记一笔固定用例扩充。
- 问一句固定用例扩充。
- 历史报告整理和版本标注。
- UI 人工验收清单。
- 真实老板样本匿名化规则。
- promptfoo 报告展示优化。
- 催款话术用例。
- 客户档案展示用例。

## 15. 哪些测试必须串行补

以下测试必须串行推进，避免业务规则互相打架：

- 收款核销状态机测试。
- 应收款状态转换测试。
- 订单定金和尾款计算测试。
- 报价转订单幂等测试。
- parser 结果到 `saveConfirmedDraft()` 的端到端保存测试。
- 本地存储结构迁移测试。
- 真实 AI 与本地 mock 差异测试。
- 小程序 UI 自动化基础设施选型和落地。

