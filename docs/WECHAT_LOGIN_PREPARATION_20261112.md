# 微信登录联调准备（2026-11-12）

> 后续进展：用户完成目录窗口操作后，已在独立工程取得真实登录及四项整理4/4通过结果。详见 [真实登录与AI联调](WECHAT_LOGIN_AI_INTEGRATION_20261112.md)。本文保留准备阶段的证据边界。

## 当前结论

后台证书恢复后，下一步可以由Codex继续完成登录和AI链路的检查、修复与自动测试。
本人扫码、手机权限和实际讲话只在真正需要时交给用户；不要求用户改代码、复制登录code或提供密码。

本阶段已完成独立登录验收工程及本地认证回归，尚未取得真实微信登录结果，也未调用真实模型。
开发者工具导入时，系统文件夹对话框的自动窗口定位失败，已请用户选择一次准备好的目录。
没有开启原本关闭的开发工具CLI服务端口。

## 本轮范围

1. 类型：局部铺路，准备并验证真实登录的最小测试条件，不承诺本轮全部上线。
2. 用户链路：微信登录 → 后台验真 → 登录就绪 → 后续AI整理 → 确认卡；本阶段先验证认证，不保存业务。
3. 分工：主控串行操作；配置发布、用户链路/语音两个角色只读复核。
4. 允许：仓库外新建只读验收工程、生产API client按哈希复制、本地临时测试副本、本文档和索引。
5. 禁止：不改生产parser、business、storage、app.js、app.json、project配置；不读取.env、已有token或真实业务Storage。
6. 风险：涉及认证联调；不新增账号/凭证、不更改服务器业务、不上传发布、不关闭域名或TLS校验。
7. 最小范围：只允许wx.login和精确登录POST接口，AI和业务存储继续封锁；会话仅在内存，完成即清除。
8. 验收：生产client得到真实后台会话且只显示脱敏结果；无业务Storage访问、无模型调用、不输出code/token。
9. 修改结论：可以准备独立测试代码和文档；生产功能修改须先定位具体问题并缩小范围。

## 已验证的本地认证行为

在不包含.env的临时副本中，剥离宿主AI/API/认证环境变量，采用合成配置运行：

- `scripts/auth-tests.js`：通过。覆盖签名、防篡改、到期失效、微信交换的stub、客户端自动登录、401后重新登录一次、快速核对未就绪时不发请求。
- `scripts/server-auth-integration-tests.js`：通过。本机127.0.0.1服务，覆盖未登录401、有效合成令牌放行、篡改令牌401。
- 测试preload禁止fetch、HTTPS和非loopback HTTP；外部网络尝试0，未调用模型。

证据目录：

`C:\Users\Administrator\AppData\Local\Temp\hxl-auth-check-20261112-122622`

以上是本地合成认证回归，不是微信真实登录或模型能力的证据。

## 独立真实登录验收工程

`C:\Users\Administrator\Documents\货小玲本地备份\wechat-auth-readonly-20261112`

- 沿用当前生产AppID，域名校验保持true；没有WechatSI插件，也没有生产storage/business模块。
- 生产`utils/api-client.js`逐字复制，SHA-256记录于`diagnostic-manifest.json`。
- 只允许POST `https://api.baizeji.com/api/auth/wechat-login`，请求Body只能含code。
- 会话Storage API由测试守卫映射到独立内存；业务key读写删除、清空Storage、AI/上传/下载等入口均拒绝。
- 页面仅在点击“检查微信登录”后发起，结果只包含成功与否、耗时、HTTP状态和计数；不打印code、token或认证header。
- 仅允许开发工具运行，不作为手机测试或发布包。
- 守卫自测12/12及页面JavaScript语法检查通过；未使用真实网络、存储或密钥。

UI当前导入仍待用户选择目录，不能把工程已生成写成登录已通过。
CLI官方打开命令发现服务端口关闭后没有同意启用；等待交互的本轮CLI进程已停止。

## 语音复核更正

前轮“audioReady只产生录音文件”的局部观察不足以代表实际入口的默认provider。
当前`hold-to-talk-controller.beginHold()`明确选择WechatSI，首页和底部按钮走该控制器；完整页`startVoice()`也走WechatSI。
RecorderManager V2属于隔离测试合同分支，不能据此要求先接文件ASR。
`utils/transcribe.js`的endpoint仍空，后台`transcribeWithAi()`仍是占位，填URL不能补成真实转写。

下一步应先验收WechatSI资格、授权、真实转写、最终文字依据和确认卡；实际手机录音仍未验证。

## 需要用户与Codex各自完成的事

| 环节 | 负责人 |
| --- | --- |
| 登录和AI代码检查、测试准备、定位与最小修复 | Codex |
| 已有登录会话可用时的小程序自动微信登录 | Codex操作测试程序 |
| 服务器维护、备份、自动回归与验收记录 | Codex |
| 真实设备上的扫码、首次权限、说测试句和体验意见 | 需要时由用户配合 |
| 当前无法自动定位的系统文件夹窗口 | 用户选择一次目录，后续继续交回Codex |

未commit、push、合并、上传或发布。真实AI、手机语音、备份恢复和发布前验收仍在后续范围。
