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
const deepAiRateLimiter = createRateLimiter({
  windowMs: config.aiRateLimitWindowMs,
  maxRequests: config.aiDeepRateLimitMaxRequests
});
const authLoginRateLimiter = createRateLimiter({
  windowMs: config.aiRateLimitWindowMs,
  maxRequests: config.authLoginRateLimitMaxRequests
});

function isAiRoute(req) {
  return req.method === 'POST' && ['/api/ai/parse', '/api/ai/parse/deep', '/api/ai/query', '/api/ai/transcribe'].includes(req.url);
}

function isDeepParseRoute(req) {
  return req.method === 'POST' && req.url === '/api/ai/parse/deep';
}

function createRequestId() {
  return `ai_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function getParseErrorStatus(error) {
  const code = String((error && error.code) || 'AI_PARSE_FAILED');
  if (code === 'AI_FAST_TIMEOUT' || code === 'AI_DEEP_TIMEOUT') return 504;
  if (code === 'AI_RESPONSE_INVALID' || code === 'AI_RESPONSE_EMPTY_BUSINESS') return 422;
  if (code === 'AI_PROVIDER_UNAVAILABLE') return 502;
  return 500;
}

function toSafeParseError(error) {
  const code = String((error && error.code) || 'AI_PARSE_FAILED');
  const messages = {
    AI_FAST_TIMEOUT: '智能快速核对超时。',
    AI_RESPONSE_INVALID: '智能核对没有给出可核对的结果。',
    AI_RESPONSE_EMPTY_BUSINESS: '智能核对返回了空业务结果，已拒绝采用。',
    AI_PROVIDER_UNAVAILABLE: '智能核对服务暂时不可用。',
    AI_DEEP_TIMEOUT: '深度核对超时。'
  };
  return { error: code, message: messages[code] || '智能核对暂时不可用。' };
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
    const rate = (isDeepParseRoute(req) ? deepAiRateLimiter : aiRateLimiter).consume(req, Date.now(), claims.sub);
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
    const requestId = createRequestId();
    const startedAt = Date.now();
    readJsonBody(req)
      .then((body) => parseWithAi(config, Object.assign({}, body, { reviewMode: 'standard' })))
      .then((payload) => sendJson(res, 200, Object.assign({}, payload, {
        ai_request_id: requestId,
        ai_server_elapsed_ms: Date.now() - startedAt,
        ai_deadline_ms: config.aiFastRequestTimeoutMs
      }), origin))
      .catch((error) => sendJson(res, getParseErrorStatus(error), Object.assign(toSafeParseError(error), {
        ai_request_id: requestId,
        ai_server_elapsed_ms: Date.now() - startedAt,
        ai_deadline_ms: config.aiFastRequestTimeoutMs
      }), origin));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/ai/parse/deep') {
    const requestId = createRequestId();
    const startedAt = Date.now();
    readJsonBody(req)
      .then((body) => parseWithAi(config, Object.assign({}, body, { reviewMode: 'deep' })))
      .then((payload) => sendJson(res, 200, Object.assign({}, payload, {
        ai_request_id: requestId,
        ai_server_elapsed_ms: Date.now() - startedAt,
        ai_deadline_ms: config.aiQualityRequestTimeoutMs
      }), origin))
      .catch((error) => sendJson(res, getParseErrorStatus(error), Object.assign(toSafeParseError(error), {
        ai_request_id: requestId,
        ai_server_elapsed_ms: Date.now() - startedAt,
        ai_deadline_ms: config.aiQualityRequestTimeoutMs
      }), origin));
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
server.listen(config.port, '127.0.0.1', () => {
  console.log(`AI assistant server listening on ${config.port}`);
  console.log(`Mode: ${isRealAiEnabled(config) ? 'AI' : 'mock'}`);
});
