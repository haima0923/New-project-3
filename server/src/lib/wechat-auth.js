const crypto = require('crypto');

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decode(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function createSessionToken(openid, config, now = Date.now()) {
  if (!openid || !config.authTokenSecret) throw new Error('Authentication is not configured');
  const issuedAt = Math.floor(now / 1000);
  const payload = {
    iss: 'huoxiaoling',
    sub: String(openid),
    iat: issuedAt,
    exp: issuedAt + config.authTokenTtlSeconds
  };
  const encodedPayload = encode(payload);
  return {
    token: `${encodedPayload}.${sign(encodedPayload, config.authTokenSecret)}`,
    expiresAt: new Date(payload.exp * 1000).toISOString(),
    payload
  };
}

function verifySessionToken(token, config, now = Date.now()) {
  if (!token || !config.authTokenSecret) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2 || !safeEqual(sign(parts[0], config.authTokenSecret), parts[1])) return null;
  try {
    const payload = decode(parts[0]);
    const timestamp = Math.floor(now / 1000);
    if (!payload || payload.iss !== 'huoxiaoling' || !payload.sub || !Number.isFinite(payload.exp) || payload.exp <= timestamp) return null;
    return payload;
  } catch (error) {
    return null;
  }
}

function getWechatLoginUrl(config, code) {
  const params = new URLSearchParams({
    appid: config.wechatAppId,
    secret: config.wechatAppSecret,
    js_code: code,
    grant_type: 'authorization_code'
  });
  return `https://api.weixin.qq.com/sns/jscode2session?${params.toString()}`;
}

async function exchangeWechatCode(config, code, fetchImpl = global.fetch) {
  if (!code || typeof code !== 'string') throw new Error('Missing WeChat login code');
  if (!config.wechatAppId || !config.wechatAppSecret) throw new Error('WeChat login is not configured');
  if (typeof fetchImpl !== 'function') throw new Error('Fetch is not available');

  let response;
  try {
    response = await fetchImpl(getWechatLoginUrl(config, code));
  } catch (error) {
    throw new Error('WeChat login service is unavailable');
  }

  let payload = {};
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error('WeChat login returned an invalid response');
  }
  if (!response.ok || payload.errcode || !payload.openid) {
    throw new Error('WeChat login verification failed');
  }
  return { openid: String(payload.openid) };
}

async function loginWithWechatCode(config, code, fetchImpl = global.fetch) {
  const session = await exchangeWechatCode(config, code, fetchImpl);
  return createSessionToken(session.openid, config);
}

function getBearerToken(req) {
  const value = String((req.headers && req.headers.authorization) || '');
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

module.exports = {
  createSessionToken,
  exchangeWechatCode,
  getBearerToken,
  loginWithWechatCode,
  verifySessionToken
};
