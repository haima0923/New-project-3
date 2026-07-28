# 货小玲项目文档索引

本文件用于新开 Codex 对话时快速建立项目上下文。Codex 应先读本文件，再根据任务读取对应文档。

> 当前 E2E Phase 2B.1 工作分支：`feature/record-e2e-runner-kernel-v1`；执行边界冻结基线为
> `07ea2909abaae864c5b3999f7143ff4e3f68c491` /
> `candidate-record-e2e-execution-contract-v1`，Release A与Corpus旧Tag保持冻结。
> Phase 2B.1-R2实现带Lane强证据和逐Case隔离硬门禁的Headless Runner Kernel、
> 120题plan-only与24题双轮代表性Smoke；持久化题按既有订单交期合同修正合成前置数据，
> 并发B显式单位冲突也由plan-only阻断；首次Phase 2B.1假绿结果已作废。
> 状态为 **HEADLESS NODE PAGE-METHOD RUNNER / 24-CASE SMOKE ONLY /
> NOT WX WXML E2E / REAL QWEN NOT CALLED / NOT RELEASE**。

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
| `docs/XIAOLING_CHARACTER_GUIDE.md` | 小玲角色母版、固定特征、生成流程和验收标准 |
| `docs/RECORD_SHARED_CORE_CONTRACT.md` | 记一笔共享核心输入、模式、AI adapter、状态、trace、确认态、savePlan 和适配边界的权威合同 |
| `docs/RECORD_TEST_CONTRACT_V1.md` | 第一阶段测试题、fixture、五层评分、零容忍门禁、报告和 canary 的权威合同 |
| `docs/RECORD_E2E_CASE_CONTRACT_V1.md` | E2E Case V1.1统一Schema、固定时钟、匿名fixtures、生产观察/TEST_ONLY隔离执行、事务exact replay、State Diff和Runner消费合同 |
| `docs/RECORD_E2E_RUNNER_KERNEL_V1.md` | Phase 2B.1独立Worker、真实页面JS方法、Fake wx/network/voice、隔离Legacy提交、Lane、Evidence、24题Smoke和假绿自测 |
| `docs/RECORD_WX_STORAGE_RUNTIME_TEST_PLAYBOOK.md` | Phase 1E.2A.2 微信开发者工具隔离 Storage 事务验证步骤、恢复顺序和清理规则 |
| `docs/RECORD_SHARED_SAVE_CUTOVER_PLAN.md` | Phase 1E.2B.1 共享保存受控切换、资格、回退、Recovery Lock、监测和 Release A/B/C 计划；不代表生产已开启 |
| `docs/RECORD_RELEASE_A_RC1_CHECKLIST.md` | Release A RC1 的23个Legacy writer、启动恢复、事务失败、旧Bundle升级、回滚兼容和人工发布评审清单；尚未上传或发布 |
| `docs/PARSER_AI_AUDIT.md` | 记一笔 parser / AI 链路审计 |
| `docs/BUSINESS_FLOW_AUDIT.md` | 报价、订单、待收款、收款、定金、催款业务流转 |
| `docs/TEST_AUDIT.md` | 当前测试能力、可运行脚本、缺口和回归建议 |
| `docs/CONFIG_RELEASE_AUDIT.md` | app.js、app.json、小程序发布配置风险 |
| `docs/RECORD_CONFIRM_CARD_SPEC.md` | 记一笔确认卡字段标准和多商品阶段规则 |
| `docs/RELEASE_TEST_SYSTEM_V2.md` | 当前测试证据边界、P0 状态和后续发布门禁 |
| `docs/体验版真机测试清单.md` | 体验版人工验收步骤；Node P0 已验证，但仍不能代替微信运行时发布批准 |

权威关系：

- `AGENTS.md` 是项目和产品最高规则。
- `docs/RECORD_CONFIRM_CARD_SPEC.md` 管用户可见字段和确认卡产品语义。
- `docs/RECORD_SHARED_CORE_CONTRACT.md` 管共享核心的接口和平台边界。
- `docs/RECORD_TEST_CONTRACT_V1.md` 管第一阶段自动测试、评分和报告。
- `docs/RECORD_E2E_CASE_CONTRACT_V1.md` 管 120 条核心题的机器结构和跨 Runner 复用边界；PAGE、HEADLESS、TEST_ONLY隔离提交和事务exact replay必须分lane判分。
- `docs/RECORD_E2E_RUNNER_KERNEL_V1.md` 管Phase 2B.1 Headless执行内核；它只证明24题Smoke与Runner能力，不代表120题全量、WXML页面E2E或真实千问质量。
- `docs/RECORD_SHARED_SAVE_CUTOVER_PLAN.md` 管共享保存切换控制与发布顺序；它从属于共享核心安全合同，不能覆盖生产固定 `LEGACY_ONLY` 或自行批准 canary。
- `docs/RECORD_RELEASE_A_RC1_CHECKLIST.md` 管 Release A 候选证据和发布前人工检查；它不构成上传、发布或开启 Shared 的授权。
- `PARSER_AI_AUDIT.md`、`BUSINESS_FLOW_AUDIT.md`、`TEST_AUDIT.md` 是代码事实审计；
  审计中的历史结论不覆盖较新的合同和当前代码。
- 合同尚未实现。合同描述的目标能力不能写成当前已上线能力。

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
- 自动生成报告不进入 Git 源代码候选快照；需要时由固定提交重新生成。
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
docs/RECORD_SHARED_CORE_CONTRACT.md
docs/RECORD_TEST_CONTRACT_V1.md
docs/RECORD_E2E_CASE_CONTRACT_V1.md
docs/RECORD_E2E_RUNNER_KERNEL_V1.md
docs/PARSER_AI_AUDIT.md
docs/BUSINESS_FLOW_AUDIT.md
docs/TEST_AUDIT.md
docs/CODE_MAP.md
docs/RELEASE_TEST_SYSTEM_V2.md
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
docs/RECORD_SHARED_CORE_CONTRACT.md
docs/RECORD_TEST_CONTRACT_V1.md
docs/RECORD_E2E_CASE_CONTRACT_V1.md
docs/RECORD_E2E_RUNNER_KERNEL_V1.md
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
docs/RECORD_SHARED_CORE_CONTRACT.md
docs/RECORD_TEST_CONTRACT_V1.md
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
docs/RECORD_CONFIRM_CARD_SPEC.md（涉及记一笔确认卡时）
docs/RECORD_SHARED_CORE_CONTRACT.md（涉及记一笔页面判断时）
docs/RECORD_TEST_CONTRACT_V1.md（涉及记一笔页面验收时）
docs/XIAOLING_CHARACTER_GUIDE.md（涉及小玲形象时）
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
docs/RECORD_SHARED_CORE_CONTRACT.md
docs/RECORD_TEST_CONTRACT_V1.md
```

注意：

- 旧审计用于了解当前和历史事实；新共享核心/测试实现与验收以两份合同为准。
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
