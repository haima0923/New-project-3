# 后台证书修复与自动续期（2026-11-12）

## 当前结果

`https://api.baizeji.com` 的过期证书已经在阿里云服务器上更新并生效。
新证书有效期到北京时间 **2027-02-10 11:02:12**。
正常证书校验下，Windows 外网、指定目标IP及服务器内HTTPS健康检查均成功；未登录智能接口返回401。
专用自动续期任务已启用，保存后的认证方式演练通过，续期服务实际执行成功。

这是后台连通性修复，不是小程序上线验收。未进行真实模型推理、手机语音或小程序发布。

## 范围与启动约定

- 类型：后台证书维护的完整交付；不承诺全部产品功能上线。
- 链路：小程序 → 正常HTTPS域名 → 后台服务 → 微信登录保护；恢复证书并验证自动续期。
- 分工：主控串行操作；配置发布角色只读核对官方资料和方案。
- 允许：目标域名证书、该域名Nginx跳转、专用续期服务与定时器、维护文档和本地证据。
- 禁止：不改小程序parser/business/storage/App或发布配置，不部署Node业务，不动其他站点和证书。
- 风险：属于线上配置维护；先做服务器私有备份及验证演练，再更新，仅平滑加载Nginx。
- 最小修改：目标证书续期、目标域名一处跳转、两个专用systemd unit。
- 验收：正常TLS、域名/指纹/日期、健康检查、401保护、定时器和实际续期检查均有证据。
- 授权：用户已交付本轮修复并确认阿里云及IP；使用已有登录会话和正常云助手，不新增云访问权限或索要密码。

## 目标确认与原故障

- 用户确认：阿里云公网IP `39.105.7.48`。
- 控制台核对：华北2（北京），实例 `i-2ze1nvbfj95ao4upqih9`，运行中，现有云助手正常。
- Nginx配置：`/etc/nginx/conf.d/yiwu-ai-api.conf`。
- 目标证书：`/etc/letsencrypt/live/api.baizeji.com/fullchain.pem`，原指向archive/fullchain1.pem。
- 旧证书：2026-06-17签发，2026-09-15到期，与Windows检测到的过期证书一致。
- Certbot版本1.22.0，原续期方式为manual，偏好dns-01，没有手工认证自动化hook。
- 旧全局certbot-renew.timer为enabled但inactive/dead，没有下一次计划或历史触发时间。
- 该域名HTTP块原来跳到 `https://39.105.7.48$request_uri`。
- 后台本机健康检查原本正常，自报 `mode=ai`、`authRequired=true`，不能把它写成模型质量已验收。

同一Nginx还服务另一个站点。本次记录其配置与公钥证书哈希，并在演练、真实续期、自动化检查后逐项比较。
没有续期全部证书，也没有启动或禁用旧的全局定时器。

## 备份与实际变更

服务器私有备份目录：

`/root/hxl-cert-backup-20261112T035738Z`

目录权限700，归档按私有权限生成。包含整个Nginx和Let’s Encrypt配置、证书与符号链接目标，
以及配置哈希基准、原API配置和各阶段结果。私钥和完整服务器归档一直保留在服务器，没有下载到电脑、聊天或Git仓库。

具体操作：

1. 先确认目标配置和renewal文件SHA与只读诊断一致，Nginx active、配置检查通过，创建并校验备份。
2. 只将目标API域名的唯一跳转行由旧IP改为固定域名，保留字面量 `$request_uri`。
3. 配置检查通过后平滑加载，建立“已修正跳转”的新Nginx哈希基准。
4. 使用现有nginx认证插件，对该cert-name执行HTTP-01验证演练；清理后Nginx全配置与新基准一致。
5. 仅真实续期 `api.baizeji.com`，保存nginx/http-01认证方式，以及“配置检查通过才reload”的逐证书hook。
6. 新建并启用专用systemd续期任务，实际运行一次，另以保存后的配置完成一次验证演练。
7. 从Windows正常校验证书并验证健康检查、401及HTTP跳转，再独立核对服务器最终状态。

新证书：

- Subject：CN=api.baizeji.com。
- Issuer：Let’s Encrypt YR2。
- 到期：`2027-02-10T03:02:12Z`，即北京时间2027-02-10 11:02:12。
- SHA-256：`1A:D0:8A:19:C6:D9:8B:4A:DC:AF:C7:7E:04:03:F1:D0:34:87:0A:A1:24:E1:04:18:66:03:1F:BC:13:9F:3B:C5`。

## 自动续期

新增服务器文件：

- `/etc/systemd/system/huoxiaoling-api-cert-renew.service`
- `/etc/systemd/system/huoxiaoling-api-cert-renew.timer`

任务每天检查两次，带最多30分钟随机延迟，开机自动启用，只选择 `api.baizeji.com`。
续期前检查Nginx运行状态与配置，成功更新证书后检查配置并平滑加载，不重启ECS或Node业务。
任务在服务器运行，用户电脑关闭和阿里云网页退出不影响它执行。

最后独立核对：

- timer：loaded / active / waiting / enabled。
- 当时报告的下次执行时间：2026-11-12 15:21:10 CST；后续以实际timer为准。
- service实际执行：2026-11-12 12:08:30–12:08:31 CST，Result=success，ExecMainStatus=0，ConditionResult=yes。
- 使用已保存认证方式的dry-run：通过，不依靠手工传入认证器或挑战类型。
- 例行检查没有再次签发证书，目标证书内容保持一致。

旧全局timer的既有enabled/inactive状态未改；以后维护时仍应区分全局任务和本次专用任务，不直接启用全量续期来代替检查。

## 验证结果与边界

| 验证 | 当前结果 |
| --- | --- |
| Windows正常域名HTTPS健康检查 | 成功，ok=true，身份为项目后台 |
| Windows指定39.105.7.48并仍按域名校验HTTPS | 成功，相同后台身份 |
| Windows TLS证书链及域名校验 | PolicyErrors=None，与服务器新证书SHA-256匹配 |
| 未登录POST /api/ai/parse（空JSON，无业务内容） | 401 AUTH_REQUIRED |
| HTTP /health | 301到 https://api.baizeji.com/health |
| 服务器内正常HTTPS健康检查 | 成功，authRequired=true |
| 真实续期和保存后认证方式演练 | 通过 |
| Nginx配置检查及运行状态 | 通过，active |
| 共享站点配置和公钥证书 | 哈希未变 |
| Nginx master PID | 保持3830871，正常平滑加载 |
| 专用定时器与续期服务 | 已启用且实际运行成功 |

所有外网验收均未使用 `-k`、`--insecure` 或跳过证书校验。没有关闭微信域名校验来制造通过。
没有修改DNS、安全组、密码、云权限或实例配置；没有重启实例、部署业务或调用实际AI推理。
Nginx认证插件会临时加入验证配置并平滑加载，清理后已与基准比较，不将其描述为“完全不碰Nginx”。

## 执行记录中的两处纠正

1. 首次结构化只读诊断使用了新Python的text参数，服务器Python3.6拒绝；改用兼容参数后完成。失败没有改业务配置。
2. 设置自动续期时，编辑器第二次填入脚本导致两个设置块重复。第一块已完成配置与演练并返回active/enabled；
   第二块被“目标unit已经存在”的保护在修改前阻断，云助手该条任务整体记为exit1。
   未重复签发或覆盖任务。随后使用全新只读/例行检查脚本独立确认内容哈希、实际服务执行和timer状态，成功exit0。

最终独立验证执行ID：`t-bj072usoaeaham8`。不要把被保护阻断的历史任务记录误认为当前续期服务仍失败。

## 本地证据

`C:\Users\Administrator\Documents\货小玲本地备份\certificate-repair-20261112`

包含脱敏诊断、公钥证书元数据、执行脚本、演练/续期/定时器结果、Windows复测、最终成功截图。
没有服务器私钥、ACME账户私钥、AppSecret、AI Key、会话令牌或真实业务数据。

本轮未修改小程序业务源码，也未commit、push、合并或发布。下一阶段再验证真实微信登录与AI链路，继续处理语音和手机验收。

## 技术依据

本轮参数按现有Certbot1.22源码核对，未套用仅新版本支持的参数：
[续期选择与参数](https://github.com/certbot/certbot/blob/v1.22.0/certbot/certbot/_internal/renewal.py)、
[成功后保存配置](https://github.com/certbot/certbot/blob/v1.22.0/certbot/certbot/_internal/storage.py)、
[Nginx验证配置](https://github.com/certbot/certbot/blob/v1.22.0/certbot-nginx/certbot_nginx/_internal/http_01.py)。
Certbot hook退出状态不是独立验收依据，所以另行验证正常TLS、证书指纹、Nginx状态及定时器。
