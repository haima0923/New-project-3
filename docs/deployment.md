# 货小玲正式环境部署说明

> **当前候选分支 `snapshot/record-ai-test-worktree-20260722` 是 P0 OPEN 快照，
> 不是发布基线。** 运行时快照为 `e0fff05`，测试源码与 fixture 快照为 `ebff81e`。
> `record-flow-gate --live-ai` 暂停作为发布依据；standard/deep 合法空业务 JSON
> 仍可能被当作成功。两个 P0 修复并回归通过前，不得按本说明批准正式发布。

这套部署用于小程序真机预览和正式发布。当前小程序会请求：

```text
微信小程序 -> https://api.baizeji.com -> Node 后端 -> AI 服务
```

正式环境必须启用微信登录校验：未登录用户不能直接调用 AI 接口。不要把 AppSecret、AI Key 或令牌密钥写进小程序代码、Git 仓库或聊天记录。

## 1. 域名解析

在域名 DNS 里新增：

```text
类型：A
主机记录：api
记录值：你的服务器公网 IP
```

等待解析生效后检查：

```bash
ping api.你的域名.com
```

## 2. 服务器安装基础环境

Linux 服务器示例：

```bash
sudo apt update
sudo apt install -y nginx
node -v
npm -v
```

Node 版本建议 20 或以上。PM2：

```bash
npm install -g pm2
```

## 3. 上传并启动后端

把项目里的 `server/` 目录上传到服务器，例如：

```text
/var/www/yiwu-ai/server
```

注意：必须上传完整 `server/` 目录，里面包含 `src/`、`utils/`、`deploy/`、`package.json`。只上传 `src/` 会导致 mock AI 找不到解析工具文件。

进入目录：

```bash
cd /var/www/yiwu-ai/server
cp .env.example .env
```

正式环境的 `.env` 至少应包含：

```text
PORT=3001
NODE_ENV=production
AUTH_REQUIRED=true
WECHAT_APP_ID=你的正式小程序AppID
WECHAT_APP_SECRET=仅在微信公众平台查看后填写
AUTH_TOKEN_SECRET=至少32位、随机且独立的密钥
AUTH_TOKEN_TTL_SECONDS=604800
```

再填入当前实际使用的 AI 服务配置：

```text
AI_PROVIDER=你的实际服务商配置
AI_API_KEY=仅在服务器填写
AI_BASE_URL=你的实际服务地址
AI_MODEL=你的实际模型名
```

启动或更新：

```bash
pm2 startOrRestart src/server.js --name yiwu-ai-server
pm2 save
```

本机检查：

```bash
curl http://127.0.0.1:3001/health
```

应同时返回 `"authRequired":true`：

```json
{"ok":true,"service":"yiwu-boss-ai-assistant-server","mode":"ai","authRequired":true}
```

如果健康检查里没有 `authRequired`，或它是 `false`，说明仍在运行旧版/未保护服务器，不能上线。

## 4. Nginx 反向代理

示例配置 `/etc/nginx/sites-available/yiwu-ai-api`：

```nginx
server {
    listen 80;
    server_name api.你的域名.com;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

启用：

```bash
sudo ln -s /etc/nginx/sites-available/yiwu-ai-api /etc/nginx/sites-enabled/yiwu-ai-api
sudo nginx -t
sudo systemctl reload nginx
```

## 5. HTTPS 证书

如果使用 certbot：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.你的域名.com
```

公网检查：

```bash
curl https://api.你的域名.com/health
```

## 6. 小程序配置

当前 `app.js` 已指向正式域名，无需再把域名改成示例域名。发布前确认它仍是：

```js
globalData: {
  userId: 'local-user',
  apiBaseUrl: 'https://api.baizeji.com',
  aiAuthEnabled: true,
  aiParseEndpoint: '/api/ai/parse'
}
```

微信公众平台：

```text
开发管理 -> 开发设置 -> 服务器域名 -> request 合法域名
```

添加并保存：

```text
https://api.baizeji.com
```

微信开发者工具里重新编译，然后手机扫码预览。

## 7. 上线前安全验收

在服务器更新后，按顺序检查：

```bash
curl https://api.baizeji.com/health
curl -i -X POST https://api.baizeji.com/api/ai/parse \
  -H 'content-type: application/json' \
  -d '{"text":"王总订水杯100个"}'
```

验收标准：

- `/health` 返回 `authRequired: true`。
- 第二个请求返回 HTTP `401` 和 `AUTH_REQUIRED`，而不是识别结果。
- 真机预览中，首次点击“记一笔”会自动完成微信登录，然后正常显示确认卡。
- 在“收款”页记清最后一笔尾款后，订单自动显示“已完成”。

## 8. 真机测试句

在“记一笔”输入：

```text
马总要300个杯垫，3天后交货，9毛钱一个
```

预期确认卡片：

```text
订单
马总
杯垫
300 个
单价 0.9
总价 270
交期为 3 天后对应日期
```

## 9. 更换或调整 AI 服务

拿到 Key 后只改服务器 `.env`：

```text
AI_PROVIDER=openai-compatible
AI_API_KEY=你的key
AI_BASE_URL=https://你的模型服务/v1
AI_MODEL=你的模型名
```

重启：

```bash
pm2 restart yiwu-ai-server
curl https://api.你的域名.com/health
```

`mode` 为 `ai` 且 `authRequired` 为 `true` 后，小程序无需改页面逻辑。
