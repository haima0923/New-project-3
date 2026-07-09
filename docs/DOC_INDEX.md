# 货小玲项目文档索引

本文件用于新开 Codex 对话时快速建立项目上下文。Codex 应先读本文件，再根据任务读取对应文档。

## 1. 新对话必读

每次新开 Codex 对话，建议先读取：

```text
AGENTS.md
docs/DOC_INDEX.md
docs/MULTI_AGENT_OPERATING_GUIDE.md
docs/CODEX_DAILY_PLAYBOOK.md
```

用途：

- 明确货小玲是什么。
- 明确不能做什么。
- 明确多 Agent 怎么协作。
- 明确不懂编程的用户如何和 Codex 协作。

## 2. 核心规则文档

| 文件 | 用途 | 谁主要使用 |
| --- | --- | --- |
| `AGENTS.md` | 项目最高规则、产品定位、高风险限制 | Codex / 所有 Agent |
| `docs/MULTI_AGENT_OPERATING_GUIDE.md` | 多 Agent 操作方法、模板、边界 | 用户 / Codex |
| `docs/AGENT_WORKFLOW.md` | Agent 角色职责和协作流程 | Codex |
| `docs/CODEX_DAILY_PLAYBOOK.md` | 日常操作手册 | 用户 |
| `docs/PRODUCT_RULES.md` | 产品定位、什么能做、什么不能做 | 产品规则 Agent |
| `docs/BUG_TEMPLATE.md` | Bug 反馈模板 | 用户 |

## 3. 代码和业务理解文档

| 文件 | 用途 |
| --- | --- |
| `docs/CODE_MAP.md` | 项目结构、页面、utils、后端、测试、高风险文件 |
| `docs/PRODUCT_AUDIT.md` | 产品定位、品牌、文案、UI 风险盘点 |
| `docs/PARSER_AI_AUDIT.md` | 记一笔 parser / AI 链路审计 |
| `docs/BUSINESS_FLOW_AUDIT.md` | 报价、订单、待收款、收款、定金、催款业务流转 |
| `docs/TEST_AUDIT.md` | 当前测试能力、可运行脚本、缺口和回归建议 |
| `docs/CONFIG_RELEASE_AUDIT.md` | app.js、app.json、小程序发布配置风险 |
| `docs/RECORD_CONFIRM_CARD_SPEC.md` | 记一笔确认卡字段标准和多商品阶段规则 |

## 4. 后端 / 数据 / 部署文档

| 文件 | 用途 |
| --- | --- |
| `docs/api-contract.md` | API 合同说明 |
| `docs/database-schema.sql` | 数据库 schema 参考 |
| `docs/deployment.md` | 部署说明 |

这些不是多 Agent 操作核心文档，但涉及后端、数据库或部署时需要读取。

## 5. 历史测试报告

以下文件是历史报告，不是核心规则文档：

```text
docs/local-parse-safety-acceptance-report.*
docs/wechat-local-rules-evaluation.*
docs/wechat-local-rules-hard-evaluation.*
docs/wechat-local-rules-ultra-evaluation.*
```

注意：

- 历史报告不一定代表当前代码。
- 运行相关测试脚本可能会重新生成报告文件。
- 如果本轮不希望修改报告文件，不要运行会写报告的脚本。

## 6. 按任务类型读取哪些文档

### 6.1 记一笔 / 确认卡任务

必读：

```text
AGENTS.md
docs/DOC_INDEX.md
docs/MULTI_AGENT_OPERATING_GUIDE.md
docs/RECORD_CONFIRM_CARD_SPEC.md
docs/PARSER_AI_AUDIT.md
docs/BUSINESS_FLOW_AUDIT.md
docs/TEST_AUDIT.md
docs/CODE_MAP.md
```

重点检查：

- 输入。
- 识别。
- 确认卡。
- 保存。
- 记录页。
- 详情页。
- 问一句。
- 测试。

### 6.2 Parser / AI 识别任务

必读：

```text
docs/PARSER_AI_AUDIT.md
docs/RECORD_CONFIRM_CARD_SPEC.md
docs/TEST_AUDIT.md
docs/CODE_MAP.md
```

高风险文件：

```text
utils/parser.js
utils/ai-parser.js
utils/parse-safety.js
utils/text-normalize.js
server/
promptfoo/
scripts/
```

### 6.3 业务流转任务

必读：

```text
docs/BUSINESS_FLOW_AUDIT.md
docs/TEST_AUDIT.md
docs/CODE_MAP.md
```

适用问题：

- 报价转订单。
- 订单生成待收款。
- 收款核销。
- 部分收款。
- 订单定金。
- 催款提醒。
- 客户合并。

### 6.4 UI / 文案 / 页面体验任务

必读：

```text
docs/PRODUCT_RULES.md
docs/PRODUCT_AUDIT.md
docs/CODE_MAP.md
```

重点：

- 是否老板看得懂。
- 是否变成后台系统。
- 是否有假数据。
- 是否遗漏记录页、详情页等用户链路页面。

### 6.5 测试 / 回归任务

必读：

```text
docs/TEST_AUDIT.md
docs/CODE_MAP.md
```

注意：

- 部分测试会生成报告文件。
- 如果本轮不允许修改 docs/reports/temp，不要运行生成报告的脚本。

### 6.6 配置 / 发布 / 小程序权限任务

必读：

```text
docs/CONFIG_RELEASE_AUDIT.md
docs/deployment.md
```

高风险文件：

```text
app.js
app.json
project.config.json
project.private.config.json
sitemap.json
custom-tab-bar/
```

## 7. 当前重要项目快照

详细见：

```text
docs/PROJECT_CONTEXT_SNAPSHOT.md
```

该文件记录近期完成的工作、分支状态、确认卡改造边界和下一阶段建议。
