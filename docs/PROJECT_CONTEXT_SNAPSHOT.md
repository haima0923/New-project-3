# 货小玲项目上下文快照

更新时间：2026-07-03

本文件用于新开 Codex / ChatGPT 对话时快速理解近期项目状态。它不是长期技术规格，若后续分支合并或功能完成，应更新本文件。

## 1. 项目定位

货小玲是给义乌中小工厂老板使用的轻便 AI 生意助理微信小程序。

核心功能：

- 记一笔：一句话、文字、微信聊天 → 识别 → 确认卡 → 保存。
- 问一句：自然语言查询已有业务记录。

产品边界：

- 不是 ERP。
- 不是复杂 CRM。
- 不是财务软件。
- 不加入假数据。
- 不伪造 AI 能力。

## 2. 当前关键文档

当前项目已有文档：

```text
AGENTS.md
docs/AGENT_WORKFLOW.md
docs/BUG_TEMPLATE.md
docs/PRODUCT_RULES.md
docs/CODE_MAP.md
docs/PRODUCT_AUDIT.md
docs/PARSER_AI_AUDIT.md
docs/BUSINESS_FLOW_AUDIT.md
docs/TEST_AUDIT.md
docs/CONFIG_RELEASE_AUDIT.md
docs/CODEX_DAILY_PLAYBOOK.md
docs/RECORD_CONFIRM_CARD_SPEC.md
```

本次新增/建议新增：

```text
docs/MULTI_AGENT_OPERATING_GUIDE.md
docs/DOC_INDEX.md
docs/PROJECT_CONTEXT_SNAPSHOT.md
```

## 3. 当前多 Agent 使用原则

- 多 Agent 用于只读分析和复查。
- 真正改代码通常只允许一个实现 Agent 串行修改。
- 每个任务先判断：局部铺路，还是完整交付。
- 每个用户功能必须按用户链路看：

```text
输入 → 识别 → 确认卡 → 保存 → 记录页 → 详情页 → 问一句 → 测试
```

## 4. 已完成：记一笔确认卡展示基础改造

分支：

```text
feature/record-confirm-card-items
```

提交：

```text
95d4971 feat: improve record confirm card item display
```

已推送到 GitHub：

```text
origin/feature/record-confirm-card-items
```

本轮完成的是：

```text
完整“记一笔”确认卡展示基础改造
```

### 4.1 已完成内容

- 确认卡支持商品明细展示基础。
- 旧单商品字段可兼容成 `items[0]` 展示。
- 完整记一笔确认卡显示“原始内容”。
- 用户文案从偏专业的“应收”部分调整为“待收 / 待收款 / 欠款”。
- 记录页筛选标签从“应收”改成“待收”。
- 记录列表待收记录标题从“应收 ¥...”改成“待收 ¥...”。

### 4.2 修改文件

```text
pages/input/input.js
pages/input/input.wxml
pages/input/input.wxss
pages/records/records.js
utils/constants.js
utils/display.js
utils/home-workbench.js
```

### 4.3 明确没有完成

这轮没有完成：

- 多商品自动识别。
- 多商品正式保存结构。
- 多商品记录详情展示。
- 问一句查询多商品。
- parser 多商品拆分。
- business/storage 数据结构升级。

### 4.4 没有修改的高风险模块

本轮没有修改：

```text
utils/parser.js
utils/ai-parser.js
utils/parse-safety.js
utils/business.js
utils/storage.js
app.js
app.json
server/
scripts/
promptfoo/
docs/
```

## 5. 本轮人工验收已通过

已人工确认：

1. 记录页筛选标签“应收”变为“待收”。
2. 待收款/欠款记录标题显示为“待收 ¥金额”。
3. 普通报价、订单、待收款、收款确认卡能看到“原始内容”。
4. 粘贴微信聊天场景没有重复堆叠原文。
5. 两款产品输入时确认卡不崩、不丢原文。

注意：两款产品仍可能被合并成一个商品名，这是 parser 问题，不属于本轮。

## 6. 这次暴露的多 Agent 协作问题

第一次实现时出现两个漏项：

1. 记录页仍显示“应收”。
2. 确认卡没有稳定显示原始内容。

根因：

- 任务按文件范围执行，没有按完整用户链路验收。
- 多 Agent 分工没有在实现后强制进入“用户链路复查”。

修正原则：

- 以后每个用户功能都必须先由用户链路 Agent 检查。
- 改完后必须由测试与回归 Agent 只读复查。
- 不能只问“改了哪些文件”，还要问“用户链路是否完整”。

## 7. 下一阶段建议

建议不要在当前确认卡分支继续扩大修改。

下一阶段如果做多商品能力，建议单独开分支：

```text
feature/parser-multi-items
```

目标只做 parser 多商品识别专项，不要同时改保存结构。

第一阶段目标样例：

用户输入：

```text
赵岩定50个椅子300一个，30个凳子80一个，后天交货
```

期望识别：

```text
客户：赵岩
类型：订单
商品明细：
1. 椅子 50个 单价300
2. 凳子 30个 单价80
交期：后天
```

必须明确：

- 本阶段是否只输出 `items[]` 到确认卡。
- 是否暂不改 business/storage。
- 是否暂不改订单详情页。
- 是否暂不改问一句。

## 8. 新开 Codex 对话建议第一句话

```text
你现在在“货小玲”项目里工作。

请先读取：
- AGENTS.md
- docs/DOC_INDEX.md
- docs/MULTI_AGENT_OPERATING_GUIDE.md
- docs/PROJECT_CONTEXT_SNAPSHOT.md

本轮先不要修改文件。请先确认你理解当前项目定位、多 Agent 工作流、最近完成的确认卡展示基础改造，以及下一阶段多商品 parser 识别专项的边界。
```
