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

Without `AI_API_KEY`, the server runs in mock mode. After a model key is available, set:

```text
AI_PROVIDER=openai-compatible
AI_API_KEY=your-key
AI_BASE_URL=https://your-provider.example/v1
AI_MODEL=your-model
```

Then restart the server.
