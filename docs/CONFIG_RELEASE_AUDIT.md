# 配置与发布风险盘点

本文件作为“配置与发布风险 Agent”盘点结果，只基于当前真实配置和代码记录。本轮未修改业务代码、未修改配置文件、未运行修复。

## 1. 总体判断

当前项目是原生微信小程序，基础配置已经能支持本地开发和预览：

- `app.json` 已注册主要页面。
- 已启用自定义 `tabBar`。
- 已配置 `WechatSI` 插件和 `scope.record` 录音权限说明。
- `project.config.json` 已把 `docs`、`promptfoo`、`reports`、`scripts`、`server`、`temp`、`node_modules` 排除出小程序包。
- `server/.env` 和 `project.private.config.json` 已在 `.gitignore` 中忽略。

但发布风险较明显：

- `app.js` 当前固定写死 `apiBaseUrl: 'https://39.105.7.48'`，README 又写“前端默认请求 `https://api.baizeji.com`”，部署文档则使用 `https://api.你的域名.com` 示例，三处环境表述不一致。
- `project.config.json` 中 `urlCheck: false`，开发时方便，但发布前容易掩盖合法域名问题。
- `app.json` 的导航标题仍是旧名称“生意备忘秘书”，不是“货小玲”。
- 视觉配置仍有默认蓝 `#1677FF`，与“藏青蓝 + 金色点缀”的目标风格不完全一致。
- `aiTranscribeEndpoint` 为空，语音转文字链路未完整接通。
- 当前 AppID 是否正式可发布无法仅凭代码判断，发布前必须在微信公众平台核对主体和小程序名称。

## 2. 小程序配置现状

### 页面注册

`app.json` 当前注册页面：

- `pages/onboarding/onboarding`
- `pages/dashboard/dashboard`
- `pages/records/records`
- `pages/input/input`
- `pages/finance/finance`
- `pages/profile/profile`
- `pages/quotations/quotations`
- `pages/orders/orders`
- `pages/receivables/receivables`
- `pages/todos/todos`
- `pages/pending/pending`
- `pages/query/query`
- `pages/customer/customer`

### window 配置

当前 `window`：

- `navigationBarTitleText`: `生意备忘秘书`
- `navigationBarBackgroundColor`: `#1677FF`
- `navigationBarTextStyle`: `white`
- `backgroundTextStyle`: `light`
- `backgroundColor`: `#f5f7fb`

风险：

- 导航标题还是旧名称，不符合“货小玲”命名。
- 导航栏颜色是默认感较强的蓝色，不符合“藏青蓝 + 金色点缀”的目标。
- 背景色偏浅灰蓝，可用于轻便工具，但发布前应和全局 UI 风格统一确认。

### tabBar 配置

当前 `tabBar`：

- `custom: true`
- `color: #667085`
- `selectedColor: #1677FF`
- `backgroundColor: #ffffff`
- `borderStyle: white`

tab 列表：

- 首页：`pages/dashboard/dashboard`
- 记录：`pages/records/records`
- 话筒：`pages/input/input`
- 财务：`pages/finance/finance`
- 我的：`pages/profile/profile`

风险：

- 已启用自定义 tabBar，需要确保 `custom-tab-bar/` 组件和 `app.json` 页面路径始终同步。
- 选中颜色仍是 `#1677FF`，与目标品牌风格有偏差。
- 中间 tab 文案是“话筒”，符合语音入口心智，但如果当前语音转文字未完全接通，真机发布前需要确认用户预期。

### sitemap 配置

`sitemap.json` 当前允许所有页面：

- `action: allow`
- `page: *`

风险：

- 对工具型小程序通常不是主要风险。
- 如果后续有隐私页面或内部测试页，需要重新确认 sitemap 策略。

## 3. 全局 API 配置现状

`app.js` 当前 `globalData`：

```js
{
  userId: 'local-user',
  apiBaseUrl: 'https://39.105.7.48',
  aiParseEndpoint: '/api/ai/parse',
  aiTranscribeEndpoint: ''
}
```

### `apiBaseUrl`

当前值：

- `https://39.105.7.48`

风险：

- 使用裸 IP 作为 HTTPS API 地址，发布到微信小程序时很可能遇到合法域名、证书、备案或环境识别问题。
- 和 README 中的 `https://api.baizeji.com` 不一致。
- 和部署文档中的 `https://api.你的域名.com` 不一致。
- 无环境切换机制，测试环境和正式环境容易混用。

### `aiParseEndpoint`

当前值：

- `/api/ai/parse`

现状：

- 与 server 中 `POST /api/ai/parse` 一致。

风险：

- endpoint 路径本身一致，但 base URL 不一致会导致真机请求失败或连错环境。

### `aiTranscribeEndpoint`

当前值：

- 空字符串。

现状：

- `utils/transcribe.js` 会读取该配置。
- 如果为空，会返回“未配置语音转文字”的状态。

风险：

- 后端有 `POST /api/ai/transcribe` 入口，但前端全局未配置。
- `utils/transcribe.js` 当前未被页面实际调用。
- `pages/input/input.js` 使用 `wx.getRecorderManager()` 录音后只提示待转文字。
- 首页语音使用 `WechatSI` 插件识别，和后端转写链路不是同一套。

## 4. 微信插件和权限现状

### WechatSI 插件

`app.json` 已配置：

- 插件名：`WechatSI`
- 版本：`0.3.5`
- provider：`wx069ba97219f66d99`

使用位置：

- `utils/voice-recognition.js`
- `pages/dashboard/dashboard.js`
- `pages/profile/profile.js`

现状：

- 首页语音入口使用 `WechatSI` 的 `getRecordRecognitionManager()`。
- “我的”页面会用 `isVoiceRecognitionAvailable()` 显示语音能力状态。

风险：

- 插件权限、插件版本、真机兼容性必须在微信开发者工具和真机上确认。
- 插件识别和后端 `transcribe` 链路并存，发布前需要明确到底以哪条为准。

### 录音权限

`app.json` 已配置：

- `scope.record`

权限说明：

- “用于把老板说的话转成文字，生成记一笔确认内容。”

判断：

- 权限说明整体合理，能解释录音用途。

风险：

- 用户拒绝授权后，必须人工验证重新授权路径。
- 真机上录音权限弹窗、取消录音、弱网、无识别结果等场景需要重点测。

## 5. project.config.json 风险

### 基础信息

当前 `project.config.json`：

- `description`: `Yiwu factory owner AI assistant MVP`
- `compileType`: `miniprogram`
- `libVersion`: `3.15.1`
- `appid`: `wx975fd5297d4c13e7`
- `projectname`: `yiwu-factory-boss-ai-assistant`

风险：

- `projectname` 仍是英文项目名，不是“货小玲”。
- `appid` 是否为正式 AppID 无法仅凭代码判断。
- `libVersion` 为 `3.15.1`，发布前需在微信开发者工具确认基础库兼容目标用户手机。

### packOptions ignore

当前忽略目录：

- `docs`
- `promptfoo`
- `reports`
- `scripts`
- `server`
- `temp`
- `node_modules`

判断：

- 这些忽略项总体合理，可以避免服务端、测试、报告和临时文件进入小程序包。

风险：

- 根目录仍有 `README.md`、`AGENTS.md`、以及若干根目录测试报告 Markdown 文件，不在 `packOptions.ignore` 中。
- 如果微信开发者工具没有自动排除未引用文件，可能有包体和信息暴露风险。

### 发布相关 setting

当前关键 setting：

- `urlCheck: false`
- `es6: true`
- `postcss: true`
- `minified: true`
- `enhance: true`
- `uploadWithSourceMap: true`
- `minifyWXSS: true`
- `minifyWXML: true`
- `disableSWC: true`

风险：

- `urlCheck: false` 会让开发时绕过域名检查，发布前必须打开或在微信公众平台确认合法域名。
- `uploadWithSourceMap: true` 可能上传 source map，便于排查问题，但也需要确认是否符合发布策略。
- `minified: true`、`minifyWXSS: true`、`minifyWXML: true` 对发布有利，但压缩后问题排查要依赖 source map。

## 6. project.private.config.json 风险

### 文件现状

当前存在：

- `project.private.config.json`

内容包括：

- `libVersion: 3.15.1`
- `projectname: New%20project%203`
- `urlCheck: false`
- `compileHotReLoad: true`
- `ignoreDevUnusedFiles: true`

### Git 状态

`.gitignore` 已包含：

- `project.private.config.json`

`git ls-files project.private.config.json` 未返回跟踪记录，说明当前未被 Git 跟踪。

判断：

- 当前没有误提交迹象。

风险：

- 该文件包含个人开发工具配置，后续不应提交。
- 私有配置中的 `projectname` 和公开配置不一致，可能导致开发者工具显示名称混乱。
- 私有配置同样关闭了 `urlCheck`，真机调试容易忽略合法域名问题。

## 7. .gitignore 风险

当前 `.gitignore` 包含：

- `.DS_Store`
- `node_modules/`
- `miniprogram_npm/`
- `dist/`
- `temp/`
- `reports/promptfoo-query/`
- `reports/promptfoo-record/`
- `*.log`
- `*.tmp`
- `server/.env`
- `project.private.config.json`

### 已覆盖的风险

已忽略：

- Node 依赖。
- 构建目录。
- 临时目录。
- promptfoo 报告输出目录。
- 日志和临时文件。
- server 私密环境变量。
- 微信开发者个人配置。

### 仍需关注

风险：

- 未忽略根目录 `.env`、`.env.local`、`.env.*`。
- 未忽略 `server/.env.*`，如果后续出现 `server/.env.production` 等敏感文件，可能误提交。
- 只忽略了 `reports/promptfoo-query/` 和 `reports/promptfoo-record/`，如果后续生成其他 `reports/` 子目录，可能进入仓库。
- 历史测试报告在 `docs/` 和根目录中较多，虽然不一定敏感，但容易造成仓库膨胀和版本噪音。

## 8. API 地址和环境不一致风险

当前不同文件中的 API 环境表述：

- `app.js`: `https://39.105.7.48`
- `README.md`: 前端默认请求 `https://api.baizeji.com`
- `docs/deployment.md`: 示例为 `https://api.你的域名.com`
- `server/README.md`: 本地服务为 `http://127.0.0.1:3001`
- `server/deploy/nginx.example.conf`: 反向代理到 `http://127.0.0.1:3001`

风险：

- 开发、真机、线上发布到底使用哪个 API 地址不清晰。
- 裸 IP 和正式域名混用。
- README 与实际代码不一致，会误导联调和发布。
- 微信开发者工具关闭 `urlCheck` 时，本地可能能跑，真机或审核环境失败。

### 微信合法域名可能需要配置

需要在微信公众平台确认：

- 当前小程序正式使用的 request 合法域名。
- 如果继续使用 `api.baizeji.com`，需配置 `https://api.baizeji.com`。
- 如果改为业务域名，需配置 `https://api.你的正式域名.com`。
- 如果语音转文字使用 `wx.uploadFile`，还需确认 uploadFile 合法域名与 request 域名规则。

不建议：

- 使用裸 IP 作为正式小程序 API 地址。
- 测试环境和生产环境共用同一个硬编码地址。

## 9. AppID 与发布风险

当前 `appid`：

- `wx975fd5297d4c13e7`

无法仅凭代码判断：

- 是否正式 AppID。
- 是否测试号。
- 是否属于当前主体。
- 是否对应“货小玲”小程序。

发布前必须确认：

- 微信公众平台主体是否正确。
- 小程序名称是否为“货小玲”。
- AppID 是否与当前项目一致。
- 服务类目是否匹配业务。
- request 合法域名是否配置。
- WechatSI 插件是否允许使用。
- 体验版、审核版、正式版使用的 API 地址是否一致。

风险：

- 误用测试 AppID 会导致无法正式发布或数据隔离混乱。
- 误用他人 AppID 有发布和权限风险。
- 本地 `project.private.config.json` 与公开 `project.config.json` 项目名不同，容易让非技术人员误判当前项目。

## 10. 服务端部署风险

### 当前服务端现状

server 目录包含：

- `server/src/server.js`
- `server/src/config.js`
- `server/src/ai/model.js`
- `server/src/ai/mock.js`
- `server/.env.example`
- `server/deploy/ecosystem.config.cjs`
- `server/deploy/nginx.example.conf`
- `server/package.json`

server 接口：

- `GET /health`
- `POST /api/ai/parse`
- `POST /api/ai/query`
- `POST /api/ai/transcribe`

### 环境变量

`server/src/config.js` 读取：

- `PORT`
- `NODE_ENV`
- `AI_PROVIDER`
- `AI_API_KEY`
- `AI_BASE_URL`
- `AI_MODEL`
- `ALLOWED_ORIGINS`

默认：

- `PORT=3001`
- `AI_PROVIDER=mock`

真实 AI 启用条件：

- 有 `AI_API_KEY`
- 有 `AI_BASE_URL`
- 有 `AI_MODEL`
- `AI_PROVIDER` 不是 `mock`

### 部署风险

- 当前后端需要单独部署，不会随小程序包发布。
- `server` 已被小程序包忽略，这是正确的。
- 如果服务器 `.env` 仍是 mock，小程序即使连上后端，也只是 mock AI。
- `POST /api/ai/transcribe` 当前返回 mock 转写结果，真实语音转文字未接通。
- `ALLOWED_ORIGINS=*` 适合临时测试，不应作为长期生产策略。
- Nginx 示例只监听 80，HTTPS 需要额外证书配置。

## 11. 真机测试风险

真机测试重点风险：

- `https://39.105.7.48` 是否有合法证书。
- 微信是否允许该地址作为 request 合法域名。
- `urlCheck: false` 在开发工具里可能掩盖真机问题。
- 手机扫码预览时是否能访问 `/health`、`/api/ai/parse`、`/api/ai/query`。
- 服务器当前是 `mock` 还是 `ai` 模式。
- 首页 `WechatSI` 语音识别在真机上是否可用。
- 录音权限被拒绝后是否能恢复。
- `pages/input/input` 录音后没有真正转文字，用户可能误以为语音已经接通。
- 弱网、接口超时、证书异常时是否有可理解提示。
- 本地 `wx.setStorageSync` 数据不会跨手机同步，真机换设备后数据为空属于当前技术状态。

## 12. 发布前检查清单

### 微信开发者工具检查

- 确认项目 AppID 是否正确。
- 确认项目名称是否和“货小玲”一致。
- 检查详情面板里的“不校验合法域名”是否关闭或已明确仅用于开发。
- 点击“上传”前查看包体大小。
- 确认上传包中没有 `server`、`scripts`、`promptfoo`、`reports`、`docs`。
- 确认基础库版本兼容目标用户手机。
- 确认 `WechatSI` 插件没有报错。

### 真机测试检查

- 首页是否能打开。
- 底部导航是否正常。
- 记一笔手动输入是否能生成确认卡。
- 粘贴微信聊天是否能识别。
- 首页语音按钮是否能弹权限并识别。
- 输入页录音入口是否清楚提示当前能力。
- 问一句是否能查询欠款、交期、报价。
- API 失败时是否有可理解提示。
- 退出重进后本地数据是否仍在。

### API 地址检查

- `app.js` 中 `apiBaseUrl` 是否为正式 HTTPS 域名。
- `aiParseEndpoint` 是否为 `/api/ai/parse`。
- 如启用语音转写，`aiTranscribeEndpoint` 是否已配置。
- 微信公众平台 request 合法域名是否与 `apiBaseUrl` 完全一致。
- 如果使用 uploadFile，上传合法域名是否配置。
- 服务器 `/health` 是否返回 `ok: true`。
- `/health` 的 `mode` 是否符合预期：测试为 `mock`，正式为 `ai`。

### Git 状态检查

- `git status --short` 是否只包含本轮预期文件。
- 不应提交 `project.private.config.json`。
- 不应提交 `server/.env`。
- 不应提交 `node_modules/`。
- 不应提交 `temp/`。
- 不应提交 `reports/` 临时输出。
- 不应提交真实 API Key、模型 Key、服务器密码。

### 发布材料检查

- 小程序名称：货小玲。
- 页面标题：货小玲。
- 隐私协议中是否说明录音用途。
- 服务类目是否匹配。
- 客服、主体、图标、截图等是否准备好。

## 13. 高风险问题

高风险问题清单：

- `app.js` 硬编码 `https://39.105.7.48`，且与 README / 部署文档不一致。
- `project.config.json` 与 `project.private.config.json` 都关闭 `urlCheck`。
- `app.json` 导航标题仍是旧名称“生意备忘秘书”。
- AppID 是否正式、是否属于当前小程序主体无法判断。
- `aiTranscribeEndpoint` 为空，语音转文字未完整接通。
- `WechatSI` 插件语音链路和后端转写链路并存，能力边界不清。
- README 中 API 默认地址和代码实际地址不一致。
- `uploadWithSourceMap: true` 发布策略需要确认。
- 根目录文档和测试报告未全部进入 packOptions ignore。
- `.gitignore` 对未来 `.env.*`、`server/.env.*`、其他 `reports/` 子目录覆盖不够完整。

## 14. 后续建议修复顺序

建议顺序：

1. 先确认正式 AppID、小程序名称、主体和服务类目。
2. 确认正式 API 域名，统一 `app.js`、README、部署文档中的 API 地址。
3. 在微信公众平台配置 request 合法域名。
4. 决定语音方案：使用 `WechatSI`，还是后端 `/api/ai/transcribe`，避免两套链路混淆。
5. 发布前打开或复核合法域名校验，避免 `urlCheck: false` 掩盖问题。
6. 统一产品命名，把旧名称改为“货小玲”。
7. 统一品牌颜色。
8. 补充 `.gitignore` 中未来敏感环境文件规则。
9. 核查小程序包内容，确认根目录报告和文档不会进入发布包。
10. 建立发布前真机检查清单。

## 15. 哪些可以批量修

可以批量处理：

- 旧名称文案统一。
- README / docs 中环境说明统一。
- `.gitignore` 补充临时文件、环境文件规则。
- packOptions 忽略项补充。
- 颜色常量和默认蓝色统一。
- 发布前检查清单文档化。

## 16. 哪些必须单独确认后再修

必须先单独确认：

- 正式 AppID。
- 小程序主体和名称。
- 正式 API 域名。
- 是否继续使用 `https://39.105.7.48`。
- 是否使用 `https://api.baizeji.com`。
- 真实 AI 服务商、模型、Key 管理方式。
- 语音转文字方案：WechatSI 还是后端转写。
- `uploadWithSourceMap` 是否保留。
- `urlCheck` 发布前策略。
- 生产服务器部署位置、HTTPS 证书、Nginx 配置。

