#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const apiClientPath = path.join(ROOT, 'utils/api-client.js');
const {
  createSessionToken,
  exchangeWechatCode,
  loginWithWechatCode,
  verifySessionToken
} = require(path.join(ROOT, 'server/src/lib/wechat-auth.js'));
const { assertAuthConfig } = require(path.join(ROOT, 'server/src/config.js'));

const authConfig = {
  authTokenSecret: '0123456789abcdef0123456789abcdef',
  authTokenTtlSeconds: 3600,
  wechatAppId: 'wx-test-app',
  wechatAppSecret: 'test-secret'
};

function testServerToken() {
  const now = Date.UTC(2026, 6, 14, 0, 0, 0);
  const session = createSessionToken('openid_001', authConfig, now);
  const verified = verifySessionToken(session.token, authConfig, now + 1000);
  assert.strictEqual(verified.sub, 'openid_001');
  assert.strictEqual(verifySessionToken(`${session.token}x`, authConfig, now + 1000), null);
  assert.strictEqual(verifySessionToken(session.token, authConfig, now + 3601000), null);
}

async function testWechatExchange() {
  let url = '';
  const fetchStub = async (input) => {
    url = String(input);
    return {
      ok: true,
      json: async () => ({ openid: 'openid_from_wechat' })
    };
  };
  const result = await exchangeWechatCode(authConfig, 'temporary-code', fetchStub);
  assert.strictEqual(result.openid, 'openid_from_wechat');
  assert(url.includes('appid=wx-test-app'));
  assert(url.includes('js_code=temporary-code'));
  const session = await loginWithWechatCode(authConfig, 'temporary-code', fetchStub);
  assert(verifySessionToken(session.token, authConfig));
}

function testRequiredConfig() {
  assert.throws(() => assertAuthConfig({
    authRequired: true,
    wechatAppId: '',
    wechatAppSecret: '',
    authTokenSecret: '',
    authTokenTtlSeconds: 0
  }), /WECHAT_APP_ID/);
  assert.doesNotThrow(() => assertAuthConfig(Object.assign({ authRequired: true }, authConfig)));
}

async function testMiniProgramClient() {
  const storage = {};
  const requests = [];
  let loginCalls = 0;
  let parseCalls = 0;
  global.getApp = () => ({ globalData: { apiBaseUrl: 'https://example.test', aiAuthEnabled: true } });
  global.wx = {
    getStorageSync(key) { return storage[key]; },
    setStorageSync(key, value) { storage[key] = value; },
    removeStorageSync(key) { delete storage[key]; },
    login(options) {
      loginCalls += 1;
      options.success({ code: `code-${loginCalls}` });
    },
    request(options) {
      requests.push({ url: options.url, header: options.header, data: options.data });
      if (options.url.endsWith('/api/auth/wechat-login')) {
        options.success({
          statusCode: 200,
          data: { token: `token-${loginCalls}`, expiresAt: new Date(Date.now() + 3600000).toISOString() }
        });
        return;
      }
      parseCalls += 1;
      if (parseCalls === 2) {
        options.success({ statusCode: 401, data: { error: 'AUTH_REQUIRED' } });
        return;
      }
      options.success({ statusCode: 200, data: { ok: true } });
    }
  };
  delete require.cache[require.resolve(apiClientPath)];
  const { AI_AUTH_STORAGE_KEY, requestJson } = require(apiClientPath);

  await requestJson('/api/ai/parse', { text: '王总订水杯100个' });
  assert.strictEqual(loginCalls, 1);
  assert.strictEqual(requests[1].header.authorization, 'Bearer token-1');
  assert(storage[AI_AUTH_STORAGE_KEY]);

  await requestJson('/api/ai/query', { question: '王总还欠多少' });
  assert.strictEqual(loginCalls, 2, '401 should clear the old token and login once more');
  assert.strictEqual(requests[4].header.authorization, 'Bearer token-2');

  delete global.wx;
  delete global.getApp;
  delete require.cache[require.resolve(apiClientPath)];
}

async function main() {
  testServerToken();
  await testWechatExchange();
  testRequiredConfig();
  await testMiniProgramClient();
  console.log('微信登录校验测试通过：令牌、防篡改、过期、微信验真、客户端自动登录与 401 重试均已覆盖。');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
