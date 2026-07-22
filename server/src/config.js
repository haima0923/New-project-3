const fs = require('fs');
const path = require('path');

function loadEnvFile() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const index = trimmed.indexOf('=');
    if (index === -1) return;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = value;
  });
}

loadEnvFile();

function getBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function getConfig() {
  const env = process.env.NODE_ENV || 'development';
  return {
    port: Number(process.env.PORT || 3001),
    env,
    aiProvider: process.env.AI_PROVIDER || 'mock',
    aiApiKey: process.env.AI_API_KEY || '',
    aiBaseUrl: (process.env.AI_BASE_URL || '').replace(/\/$/, ''),
    aiModel: process.env.AI_MODEL || '',
    // 普通确认卡只允许一次快速核对。服务端硬性封顶 5.2 秒，给手机端的
    // 登录、网络和渲染预留时间；绝不自动回退到慢模型。
    aiFastModel: process.env.AI_FAST_MODEL || 'qwen3.6-flash',
    aiFastRequestTimeoutMs: Math.min(Math.max(1, Number(process.env.AI_FAST_REQUEST_TIMEOUT_MS) || 5200), 5200),
    aiQualityRequestTimeoutMs: Number(process.env.AI_QUALITY_REQUEST_TIMEOUT_MS || 20000),
    allowedOrigins: process.env.ALLOWED_ORIGINS || '',
    aiRateLimitWindowMs: Number(process.env.AI_RATE_LIMIT_WINDOW_MS || 60000),
    aiRateLimitMaxRequests: Number(process.env.AI_RATE_LIMIT_MAX_REQUESTS || 30),
    aiDeepRateLimitMaxRequests: Number(process.env.AI_DEEP_RATE_LIMIT_MAX_REQUESTS || 5),
    authLoginRateLimitMaxRequests: Number(process.env.AUTH_LOGIN_RATE_LIMIT_MAX_REQUESTS || 10),
    authRequired: getBoolean(process.env.AUTH_REQUIRED, env === 'production'),
    authTokenSecret: process.env.AUTH_TOKEN_SECRET || '',
    authTokenTtlSeconds: Number(process.env.AUTH_TOKEN_TTL_SECONDS || 604800),
    wechatAppId: process.env.WECHAT_APP_ID || '',
    wechatAppSecret: process.env.WECHAT_APP_SECRET || ''
  };
}

function isRealAiEnabled(config) {
  return Boolean(config.aiApiKey && config.aiBaseUrl && config.aiModel && config.aiProvider !== 'mock');
}

function assertAuthConfig(config) {
  if (!config.authRequired) return;
  const missing = [];
  if (!config.wechatAppId) missing.push('WECHAT_APP_ID');
  if (!config.wechatAppSecret) missing.push('WECHAT_APP_SECRET');
  if (!config.authTokenSecret || config.authTokenSecret.length < 32) missing.push('AUTH_TOKEN_SECRET（至少 32 个随机字符）');
  if (!Number.isFinite(config.authTokenTtlSeconds) || config.authTokenTtlSeconds <= 0) missing.push('AUTH_TOKEN_TTL_SECONDS');
  if (missing.length) throw new Error(`WeChat authentication is required but missing: ${missing.join(', ')}`);
}

module.exports = {
  assertAuthConfig,
  getConfig,
  isRealAiEnabled
};
