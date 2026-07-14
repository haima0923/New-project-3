# Yiwu Boss AI Assistant Server

No npm dependencies are required for the mock test server.

## Local Run

```bash
cp .env.example .env
node src/server.js
```

Health check:

```bash
curl http://127.0.0.1:3001/health
```

## Endpoints

- `GET /health`
- `POST /api/ai/parse`
- `POST /api/ai/query`
- `POST /api/auth/wechat-login`

Without `AI_API_KEY`, the server runs in mock mode. After a model key is available, set:

```text
AI_PROVIDER=openai-compatible
AI_API_KEY=your-key
AI_BASE_URL=https://your-provider.example/v1
AI_MODEL=your-model
```

Then restart the server.

## Before public release

- Set `ALLOWED_ORIGINS` only for any browser domains you actually operate; the
  Mini Program's `wx.request` does not require CORS.
- Set `WECHAT_APP_ID`, `WECHAT_APP_SECRET`, and a unique, random
  `AUTH_TOKEN_SECRET` (at least 32 characters) in the server environment.
  These secrets must never go into Mini Program source code or Git.
- With `NODE_ENV=production`, `AUTH_REQUIRED` defaults to `true`. The server
  will refuse to start until the above credentials are present, and all AI
  routes require a short-lived server-issued token created from `wx.login()`.
- Configure the deployed HTTPS domain as a valid Mini Program request domain
  in the WeChat Mini Program console, then redeploy this server and the Mini
  Program together. A source-code change alone does not protect an already
  deployed old server.
