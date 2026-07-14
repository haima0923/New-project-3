const http = require('http');
const { assertAuthConfig, getConfig, isRealAiEnabled } = require('./config');
const { getAllowedOrigin, readJsonBody, sendJson } = require('./lib/http');
const { createRateLimiter } = require('./lib/rate-limit');
const { getBearerToken, loginWithWechatCode, verifySessionToken } = require('./lib/wechat-auth');
const { parseWithAi, queryWithAi, transcribeWithAi } = require('./ai/model');

const config = getConfig();
const aiRateLimiter = createRateLimiter({
  windowMs: config.aiRateLimitWindowMs,
  maxRequests: config.aiRateLimitMaxRequests
});
const authLoginRateLimiter = createRateLimiter({
  windowMs: config.aiRateLimitWindowMs,
  maxRequests: config.authLoginRateLimitMaxRequests
});

function isAiRoute(req) {
  return req.method === 'POST' && ['/api/ai/parse', '/api/ai/query', '/api/ai/transcribe'].includes(req.url);
}

function isWechatLoginRoute(req) {
  return req.method === 'POST' && req.url === '/api/auth/wechat-login';
}

function authenticateAiRequest(req, res, origin) {
  if (!config.authRequired) return { sub: 'anonymous-local-mode' };
  const claims = verifySessionToken(getBearerToken(req), config);
  if (claims) return claims;
  sendJson(res, 401, {
    error: 'AUTH_REQUIRED',
    message: '请先完成微信登录后再使用智能识别。'
  }, origin);
  return null;
}

function handleRequest(req, res) {
  const origin = getAllowedOrigin(req, config.allowedOrigins);

  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {}, origin);
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, {
      ok: true,
      service: 'yiwu-boss-ai-assistant-server',
      mode: isRealAiEnabled(config) ? 'ai' : 'mock',
      authRequired: config.authRequired
    }, origin);
    return;
  }

  if (isWechatLoginRoute(req)) {
    const rate = authLoginRateLimiter.consume(req);
    if (!rate.allowed) {
      sendJson(res, 429, {
        error: 'RATE_LIMITED',
        message: '登录请求过于频繁，请稍后再试。',
        retryAfterSeconds: rate.retryAfterSeconds
      }, origin);
      return;
    }
    readJsonBody(req)
      .then((body) => loginWithWechatCode(config, String(body.code || '').trim()))
      .then((session) => sendJson(res, 200, {
        token: session.token,
        expiresAt: session.expiresAt
      }, origin))
      .catch(() => sendJson(res, 401, {
        error: 'WECHAT_LOGIN_FAILED',
        message: '微信登录校验未通过，请稍后重试。'
      }, origin));
    return;
  }

  if (isAiRoute(req)) {
    const claims = authenticateAiRequest(req, res, origin);
    if (!claims) return;
    const rate = aiRateLimiter.consume(req, Date.now(), claims.sub);
    if (!rate.allowed) {
      sendJson(res, 429, {
        error: 'RATE_LIMITED',
        message: '请求过于频繁，请稍后再试。',
        retryAfterSeconds: rate.retryAfterSeconds
      }, origin);
      return;
    }
  }

  if (req.method === 'POST' && req.url === '/api/ai/parse') {
    readJsonBody(req)
      .then((body) => parseWithAi(config, body))
      .then((payload) => sendJson(res, 200, payload, origin))
      .catch((error) => sendJson(res, 500, {
        error: 'AI_PARSE_FAILED',
        message: error.message
      }, origin));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/ai/query') {
    readJsonBody(req)
      .then((body) => queryWithAi(config, body))
      .then((payload) => sendJson(res, 200, payload, origin))
      .catch((error) => sendJson(res, 500, {
        error: 'AI_QUERY_FAILED',
        message: error.message
      }, origin));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/ai/transcribe') {
    transcribeWithAi(config)
      .then((payload) => sendJson(res, 200, payload, origin))
      .catch((error) => sendJson(res, 500, {
        error: 'AI_TRANSCRIBE_FAILED',
        message: error.message
      }, origin));
    return;
  }

  sendJson(res, 404, {
    error: 'NOT_FOUND'
  }, origin);
}

const server = http.createServer(handleRequest);
assertAuthConfig(config);
server.listen(config.port, () => {
  console.log(`AI assistant server listening on ${config.port}`);
  console.log(`Mode: ${isRealAiEnabled(config) ? 'AI' : 'mock'}`);
});
