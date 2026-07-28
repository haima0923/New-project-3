const { safeClone } = require('../../../utils/record-state-diff');
const { ALLOWED_NETWORK_PATHS } = require('./constants');

function pathFromUrl(url) {
  const value = String(url || '');
  try {
    return new URL(value).pathname;
  } catch (error) {
    const match = value.match(/(\/api\/[^?#]+)/);
    return match ? match[1] : value;
  }
}

function createGuardError(url) {
  const error = new Error(`Unknown in-memory route: ${String(url || '')}`);
  error.code = 'AUTOMATION_NETWORK_GUARD_ERROR';
  return error;
}

function createFakeNetwork(options = {}) {
  const aiFixture = options.aiFixture || null;
  const events = [];
  let realNetworkRequests = 0;
  let guardErrors = 0;
  let guardInstalled = false;
  const originals = [];

  function completeRequest(request, event) {
    const fixture = aiFixture;
    if (!fixture) {
      const error = new Error('AI fixture missing for network request');
      error.code = 'TEST_DATA_ERROR';
      event.outcome = error.code;
      if (typeof request.fail === 'function') request.fail(error);
      return;
    }
    if (fixture.kind === 'TIMEOUT') {
      const error = new Error('Synthetic AI timeout');
      error.code = fixture.expectedFailureCode || 'NETWORK_REQUEST_FAILED';
      event.outcome = error.code;
      if (typeof request.fail === 'function') request.fail(error);
      return;
    }
    if (fixture.kind === 'INVALID_JSON') {
      event.outcome = 'INVALID_JSON';
      if (typeof request.success === 'function') {
        request.success({ statusCode: 200, data: fixture.rawResponse });
      }
      return;
    }
    if (!['FAKE_RESPONSE', 'REPLAY_RESPONSE'].includes(fixture.kind)) {
      const error = new Error(`Unsupported AI fixture kind: ${fixture.kind}`);
      error.code = 'TEST_DATA_ERROR';
      event.outcome = error.code;
      if (typeof request.fail === 'function') request.fail(error);
      return;
    }
    event.outcome = 'MEMORY_RESPONSE';
    if (typeof request.success === 'function') {
      request.success({ statusCode: 200, data: safeClone(fixture.response) });
    }
  }

  function request(requestOptions = {}) {
    const requestPath = pathFromUrl(requestOptions.url);
    const event = {
      method: requestOptions.method || 'POST',
      path: requestPath,
      routeKind: 'MEMORY_ONLY',
      outcome: ''
    };
    events.push(event);
    if (!ALLOWED_NETWORK_PATHS.includes(requestPath)) {
      guardErrors += 1;
      event.outcome = 'AUTOMATION_NETWORK_GUARD_ERROR';
      const error = createGuardError(requestOptions.url);
      if (typeof requestOptions.fail === 'function') requestOptions.fail(error);
      return;
    }
    if (requestPath === '/api/auth/wechat-login') {
      event.outcome = 'SYNTHETIC_AUTH';
      if (typeof requestOptions.success === 'function') {
        requestOptions.success({
          statusCode: 200,
          data: {
            token: 'REDACTED_SYNTHETIC_TEST_TOKEN',
            expiresAt: '2027-07-15T02:00:00.000Z'
          }
        });
      }
      return;
    }
    const delay = Math.min(25, Math.max(0, Number(aiFixture && aiFixture.delayMs) || 0));
    if (delay) setTimeout(() => completeRequest(requestOptions, event), delay);
    else completeRequest(requestOptions, event);
  }

  function guardHostNetwork() {
    if (guardInstalled) return;
    guardInstalled = true;
    const blocked = () => {
      realNetworkRequests += 1;
      throw createGuardError('HOST_NETWORK');
    };
    const remember = (target, key) => {
      originals.push({ target, key, value: target[key] });
      target[key] = blocked;
    };
    const nativeFetch = global.fetch;
    originals.push({ target: global, key: 'fetch', value: nativeFetch });
    global.fetch = blocked;
    const http = require('http');
    const https = require('https');
    remember(http, 'request');
    remember(http, 'get');
    remember(https, 'request');
    remember(https, 'get');
  }

  function restoreHostNetwork() {
    originals.splice(0).forEach(({ target, key, value }) => {
      if (value === undefined) delete target[key];
      else target[key] = value;
    });
  }

  function audit() {
    return {
      allowedMemoryRequests: events.length - guardErrors,
      auditPerformed: true,
      events: safeClone(events),
      guardInstalled,
      guardErrors,
      realNetworkRequests,
      unknownFakeRouteRequests: guardErrors
    };
  }

  return {
    audit,
    guardHostNetwork,
    request,
    restoreHostNetwork
  };
}

module.exports = {
  createFakeNetwork,
  createGuardError,
  pathFromUrl
};
