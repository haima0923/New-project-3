# 真机 AI 测试环境部署说明

这套部署用于手机真机预览测试：

```text
微信小程序 -> https://api.你的域名.com -> Node 后端 -> mock AI / 真实 AI
```

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

没有 AI Key 时保持 mock：

```text
PORT=3001
AI_PROVIDER=mock
AI_API_KEY=
AI_BASE_URL=
AI_MODEL=
```

启动：

```bash
pm2 start src/server.js --name yiwu-ai-server
pm2 save
```

本机检查：

```bash
curl http://127.0.0.1:3001/health
```

应返回：

```json
{"ok":true,"service":"yiwu-boss-ai-assistant-server","mode":"mock"}
```

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

修改 `app.js`：

```js
globalData: {
  userId: 'local-user',
  apiBaseUrl: 'https://api.你的域名.com',
  aiParseEndpoint: ''
}
```

微信公众平台：

```text
开发管理 -> 开发设置 -> 服务器域名 -> request 合法域名
```

添加：

```text
https://api.你的域名.com
```

微信开发者工具里重新编译，然后手机扫码预览。

## 7. Mock AI 测试句

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

## 8. 后续切真实 AI

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

`mode` 从 `mock` 变为 `ai` 后，小程序无需改页面逻辑。
