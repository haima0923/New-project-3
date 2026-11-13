# 微信真实登录与AI只读联调（2026-11-12）

> 后续进展：本报告保留后台更新前的真实结果与12～14秒耗时。其后已完成后台版本对齐并在微信复核4/4，新有效标志、服务端路由与原文指纹通过；该轮复杂AI约19～20秒。最新结果见[后台对齐与手机语音准备](BACKEND_ALIGNMENT_AND_VOICE_CHECK_20261112.md)，不要把下文旧差异当成当前仍未修复。

## 当前结果

已在微信开发者工具Stable 2.01.2510290、基础库3.17.0中，使用当前生产AppID和正常域名校验完成真实微信登录。
随后调用生产`parseHybridInput()`及其当前源码依赖，在独立、空业务状态的测试工程验证4条整理场景，最终4/4通过。

真实模型仅测试两条自然进入AUTO_DEEP的多商品输入；后台返回provider为qwen、模型qwen3.7-plus。
最终结果逐项核对商品、数量、计数/计价单位、单价、小计、总金额、交期、原话和业务预检。
没有加载生产App、初始化业务存储、点击保存或发布小程序。

此结论是微信运行时的登录与生产整理模块联调，不是生产确认卡WXML、保存、问一句、手机或全部模型质量验收。

## 范围及授权延续

本轮延续[登录联调准备](WECHAT_LOGIN_PREPARATION_20261112.md)的局部铺路范围。
用户已完成系统目录窗口的手动操作，随后由Codex修正导入表单目录到新的登录验收工程，并选择不使用云服务；没有开通云开发或同意其服务条款。

- 允许：仓库外独立工程、按哈希复制生产整理模块、精确登录/固定测试句的deep接口、脱敏证据及文档。
- 禁止：不改生产parser/business/storage/App/项目配置，不读.env、真实记录或已有会话，不部署、上传或发布。
- 主控串行修改独立测试代码，配置/AI角色与用户链路角色只读核对候选、依赖和证据边界。
- 用户链路：真实微信登录 → 后台验真 → 生产整理模块 → 最终安全判断及只读业务预检；保存和手机属于后续验收。

## 真实登录证据

首次独立检查：

| 检查 | 结果 |
| --- | --- |
| wx.login | 调用1次 |
| POST /api/auth/wechat-login | 调用1次，HTTP200 |
| 登录耗时 | 2543ms |
| 公共及私有工程urlCheck | 均为true |
| 会话存储 | 测试独立内存，完成后清除 |
| 业务Storage访问 | 0 |
| 模型请求 | 0 |

没有让用户复制登录code、发密码或配置Key；没有打印、导出code/token/header。

## 最终四项结果

所有名字、商品和金额均来自固定验收句，未读取用户业务数据，未写入业务页面或正式记录。
业务日期由生产runtime解析为2026-11-12（Asia/Shanghai），预期交期为2026-11-30。

| 场景 | 自然路由 | 实际结果 | AI次数 | 只读预检 |
| --- | --- | --- | --- | --- |
| 水杯100个，每个5元，11月30日交 | FAST_LOCAL | 500元，原话和字段正确 | 0 | 可继续确认 |
| 水杯100个×5元＋纸袋200个×2元，11月30日交 | AUTO_DEEP | 两商品500/400元，总900元 | 1 | 可继续确认 |
| 三件套500套×6元＋三角架100个×5元，11月30日交 | AUTO_DEEP | 商品名称和单位正确，3000/500元，总3500元 | 1 | 可继续确认 |
| 水杯100个，每个5元，没有交期 | ASK_USER | dueDate留空，追问目标明确为dueDate | 0 | MISSING_REQUIRED_FIELD阻断 |

没有手工指定route、provider或绕过业务预检。
AI两例均为HTTP200、已完成、provider=qwen、模型非空、请求ID与生产parse trace一致。
生产合并结果均为attempted=true、provider_kind=REAL、status=used、business_result_valid=true；没有缺项、低置信或冲突。

执行生产安全判断：

```js
const reviewed = applyFinalParseSafety(result, { businessDate });
const preflight = evaluateRecordDomainPreflight({
  finalResult: reviewed,
  initialState: {},
  businessDate,
  originalText: text
});
```

“可继续确认”只表示只读领域预检通过；工程没有保存入口，没有伪造用户确认或创建业务记录。
这里核对的是生产合并后的字段，不能表述为模型原始回答所有字段均完整：原始响应中的计价单位、顶层金额等存在空值，生产本地事实保护及确定性计算补齐后才通过。

## 耗时、请求及版本差异

最终一轮共27616ms，包含一次真实微信登录和两次串行模型请求：

| 场景 | 客户端AI耗时 | 服务端耗时 | 请求ID |
| --- | --- | --- | --- |
| 普通多商品 | 12325ms | 11702ms | ai_mwd2cdwn_w69r8a |
| 数字商品名 | 13545ms | 13165ms | ai_mwd2cn91_9m79pj |

两例均使用quality/deep路线，未测试标准快速模型或声称所有AI内容都能在此时间完成。
接口未提供token用量和费用数据，未推测金额。

实际响应均缺少`ai_business_result_valid`字段（hasOwnProperty=false，记录为null，非显式false）。
当前本地server/src/ai/model.js的withParseMetadata会设置该字段；这是已证实的响应合同差异，提示上线前需要核对部署版本。
没有据此猜测整台服务器的版本，也没有在本轮部署后台。客户端独立验证了业务结果并执行最终安全和领域预检，未因缺失标志跳过保护。

## 隔离保护及复查

工程：

`C:\Users\Administrator\Documents\货小玲本地备份\wechat-auth-readonly-20261112`

- 25个生产utils依赖按SHA-256复制并独立只读复查一致，未修改实现。
- storage.js仅因parser使用simpleFingerprint而进入依赖闭包；顶层没有创建gateway，未调用生产startup/getState。
- 业务key读写删除、清空Storage、历史候选/上下文、其他网络均拒绝。
- 仅允许wx.login、精确登录POST、当前固定验收句的一次deep请求；不加载WechatSI，不读剪贴板。
- 会话键只在测试内存存在，不访问本机已有token，结束清除。
- 最终guard严格模式，逐一核对18个wx wrapper安装身份；页面加载及最终snapshot再验证，失败即停止。
- 守卫最终8/8自测，包含方法不可写、wrapper被篡改、重复请求、意外历史、业务Storage、会话清理。

首轮4/4通过后，只读复查指出守卫可能静默赋值失败、transport及问题目标断言不够明确。
补强后在新Boot复核四项仍4/4通过，最终wrapperIntegrity=true、installedWrappers=18。
第一轮及最终轮各2次真实模型请求，共4次；单独登录检查另1次。本轮未继续扩大真实调用。

最终Boot审计：login1 / auth1 / ai2 / sessionWrites1 / sessionRemoves2 /
blockedBusinessStorage0 / blockedNetwork0 / businessStorageAccess0 / sessionInMemory=false。
这些是测试App公开wx接口守卫与本轮页面计数，不声称覆盖微信平台内部的全部网络活动。

## 证据与边界

证据目录：

`C:\Users\Administrator\Documents\货小玲本地备份\wechat-auth-readonly-20261112-evidence`

- login-result.json、login-verified.png
- ai-integration-result.json、ai-integration-verified.png（首轮）
- ai-integration-final-result.json、ai-integration-final-verified.png（最终轮）
- 源码及守卫自测证据在独立工程内，manifest记录25份生产依赖哈希。

没有真实业务数据、密钥、code或token。没有commit、push、合并、服务器业务部署或小程序发布。

尚未验证：生产确认卡和保存全过程的真实AI链路、问一句、真实网络失败/弱网、WechatSI/手机录音、备份恢复、微信平台权限和发布资格。
下一步先核对部署合同差异及语音资格，再准备手机完整验收；只有本人扫码、首次手机权限和实际讲话等环节需要用户配合。
