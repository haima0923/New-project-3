# 最近修复的GitHub同步范围（2026-11-13）

## 启动协议与授权

1. 完整交付任务：将Windows上最近几轮尚未提交的修复、测试及文档整理提交并推送至haima0923/New-project-3。
2. 用户链路：本地修复清单→备份及脱敏审查→离线回归→提交→推送当前工作分支→核对远程提交与本地一致，提供可打开的最新代码链接。
3. 三位协作者只读检查提交安全、服务端依赖、测试和文档；主控唯一执行暂存、提交和推送。
4. 允许提交本轮备份清单中的77个代码/测试/文档候选，加本文；文档索引随之补充同步说明。
5. 禁止上传.env、机器私有配置、登录状态、真实业务Storage、录音、手机原始JSON、证书及私钥；不修改线上服务，不发布小程序，不合并其他分支或强制覆盖远程历史。
6. 包含之前已授权完成的parser、保存计划及后台日期等修复，本轮不新增业务实现。生产共享保存切换仍关闭，既有已知验收边界保留。
7. 最小操作：当前codex/windows-regression-baseline分支提交并推送；不变更默认main，不改代理或Git全局设置。命令级跳过本机失效代理，仅用于连接目标GitHub。
8. 验收：候选文件、依赖、忽略规则和敏感模式检查；测试通过；远程该分支提交SHA与本地HEAD一致；工作区无遗漏未提交修复。
9. 用户明确要求“把最近几轮的修复都推送到这个仓库”，已授权commit与push，无须再次询问。没有授权上线或合并main。

## 版本基线与范围

本地基线为fe7e5a3ed67abc339d8d8c472cda1ba129819ca0，目标仓库https://github.com/haima0923/New-project-3。推送前已刷新origin，原主分支和原开发分支没有相对本机已知基线的更新；目标工作分支此前不存在。

本次集中保存以下阶段成果：

- Windows固定时钟、离线守卫、报告及栈路径兼容。
- 确认卡提示、首页转完整页合同、保存元数据与日期一致性。
- 常见记一笔说法、无标点数量、三角架/三件套等商品名称边界。
- 补答金额、交期和计价单位连续核对，原话及人工确认证明保留。
- “问一句”的指定客户范围保护。
- 首次语音与微信登录衔接、取消和迟到结果保护。
- 常见交期、中文日期、月底、半个月及周数的前后台源码对齐。
- 各轮修复与真实页面/手机联调的证据索引和尚未完成事项。

77个原候选已在仓库外按文件SHA256及原始diff备份。三位协作者只读审查未发现待提交的真实凭据或业务导出；新商品规则helper和fixed-test-clock依赖必须随本轮一起提交。47个JavaScript语法检查、4个JSON解析均通过。

## 本次提交前验证

全部通过scripts/run-record-offline-regression.js受控入口，日志在仓库外github-sync-20261113-141042目录。网络尝试均为0，未调用真实AI或保存真实业务。

| 专项 | 结果 |
| --- | --- |
| user-journey | 124/124，双轮 |
| query-customer-boundaries | 60/60 |
| query-core-existing | 14/14 |
| voice-auth-continuation | 32/32 |
| offline-guard-self-tests | 18/18 |
| parser-invocation-graph | 26/26 |
| entry-handoff | 4/4 |
| save-date-consistency | 17/17 |
| confirmation-consistency | 11/11 |
| runner-kernel | 79/79 |
| full-corpus-report-self-tests | 28/28 |
| voice-runtime-readiness | PASS14、CASE_FAIL0、RUNNER_ERROR0；7条BASELINE_DRIFT保留 |
| assistant-answer-types | 10/10 |
| release-a-rc1 | 16/16 |
| shared-core-phase1e1 | 22/22 |
| shared-core-phase1e2a1 | 22/22 |
| shared-core-phase1e2a2-static | 19/19 |
| corpus-validator | 120条题目结构合同有效 |

语音readiness的BASELINE_DRIFT是该脚本报告的观察基线差异，本轮不修改expected来消除。核心120题的业务全量执行仍是历史单独记录的25通过/95 CASE_FAIL，不能把结构校验通过当成120题业务全部通过。

## 同步与上线边界

此文件记录本次同步范围，实际提交SHA以该分支Git记录及仓库外远程核对结果为准。历史文档中的“未commit/push”指各轮完成时状态，保留原始证据口径。

GitHub代码同步不更改已部署后台和手机旧包。本轮没有部署服务器、上传小程序测试包、提交微信审核或正式发布；真实AI与完整真机发布验收仍按文档索引中的边界推进。
