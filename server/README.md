# Yiwu Boss AI Assistant Server

No npm dependencies are required for the mock test server.

> Candidate fix status (2026-07-22): **P0 TARGETED DYNAMIC TESTS PASSED /
> WECHAT RUNTIME VALIDATION PENDING / NOT RELEASE**. Commits `d652d97` and
> `457f84d` reject empty business AI responses, preserve live failures, and pass
> offline fake/mock Node regression. Real AI, Mini Program runtime, and device
> validation have not run, so this is not release evidence.

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
# Optional. Simple, complete voice / single-message records use this faster model.
# Complex chats, historical records and payment/receivable records still use AI_MODEL.
AI_FAST_MODEL=qwen3.6-flash
AI_FAST_REQUEST_TIMEOUT_MS=5200
AI_QUALITY_REQUEST_TIMEOUT_MS=20000
```

Then restart the server.

For Qwen structured extraction, the server explicitly disables the model's
thinking mode and requests JSON. This keeps the confirmation-card response
focused on fields instead of a long reasoning process. A standard request uses
the fast model once. If it fails or returns an uncertain result, the current
code returns a failure and does **not** automatically retry with `AI_MODEL`.
The quality model is used only for an explicit deep-review request.

The server caps the fast model at 5.2 seconds and the quality model at 20
seconds. The Mini Program's total wait limits are 8 seconds for standard and 25
seconds for deep review. Blocking an unsafe save is the intended behavior.

Standard and deep parsing share the same business-result validity check. Empty
objects, empty `fields`, metadata-only objects and empty item results fail with
`AI_RESPONSE_EMPTY_BUSINESS` (HTTP 422). An explicit "not enough information" or
"needs confirmation" conclusion is retained as an uncertain safety result; it
does not authorize a formal save. The Mini Program validates again before
merging, and its final business save gate requires both `status: used` and an
explicit valid-result flag. Targeted offline Node regression has now passed with
a synthetic localhost provider, but it is not release proof; real AI and WeChat
runtime validation are still required before release.

Production standard/deep prompts are defined in `src/ai/model.js`. Prompts in
`../scripts/lib/real-ai-comparison-prompts.js` are experimental evaluation
prompts and are not production prompts.

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
