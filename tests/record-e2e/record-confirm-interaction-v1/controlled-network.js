const { safeClone, stableHash } = require('../../../utils/record-state-diff');

function pathFromUrl(url) {
  const value = String(url || '');
  try {
    return new URL(value).pathname;
  } catch (error) {
    const match = value.match(/(\/api\/[^?#]+)/);
    return match ? match[1] : value;
  }
}

function responseForRequest(controller, event) {
  if (typeof controller.responseFactory === 'function') {
    return controller.responseFactory(event);
  }
  return safeClone(controller.response || {});
}

function createControlledNetwork(options = {}) {
  const controller = {
    mode: options.mode || 'SUCCESS',
    response: safeClone(options.response || {}),
    responseFactory: options.responseFactory || null
  };
  const events = [];
  const deferred = [];
  let realNetworkRequests = 0;
  let guardInstalled = false;
  const originals = [];

  function success(request, event, statusCode, data) {
    event.outcome = `HTTP_${statusCode}`;
    event.settled = true;
    if (typeof request.success === 'function') {
      request.success({ statusCode, data: safeClone(data) });
    }
  }

  function fail(request, event, code, message) {
    const error = new Error(message || code);
    error.code = code;
    error.errMsg = message || code;
    event.outcome = code;
    event.settled = true;
    if (typeof request.fail === 'function') request.fail(error);
  }

  function complete(request, event, override = {}) {
    const mode = override.mode || controller.mode;
    const data = Object.prototype.hasOwnProperty.call(override, 'response')
      ? override.response
      : responseForRequest(controller, event);
    if (mode === 'TIMEOUT') return fail(request, event, 'NETWORK_REQUEST_FAILED', 'request:fail timeout');
    if (mode === 'HTTP_401') return success(request, event, 401, {
      error: 'AUTH_REQUIRED',
      fields: { customerName: 'DIRTY_AI_401_CUSTOMER', productName: 'DIRTY_AI_401_PRODUCT' },
      manual_fields: ['productName']
    });
    if (mode === 'HTTP_500') return success(request, event, 500, {
      error: 'SERVER_ERROR',
      fields: { customerName: 'DIRTY_AI_500_CUSTOMER', productName: 'DIRTY_AI_500_PRODUCT' },
      user_manual_edits: [{ field: 'productName', source: 'USER_ASSISTANT_ANSWER' }]
    });
    if (mode === 'INVALID_JSON') return success(request, event, 200, '{invalid-json');
    if (mode === 'EMPTY_PAYLOAD') return success(request, event, 200, {});
    if (mode === 'UNKNOWN_PROVIDER') {
      return fail(
        request,
        event,
        'AI_PROVIDER_IDENTITY_UNRESOLVED',
        'trusted transport provider identity unavailable'
      );
    }
    return success(request, event, 200, data);
  }

  function request(requestOptions = {}) {
    const path = pathFromUrl(requestOptions.url);
    const requestData = requestOptions.data || {};
    const independentlyComputedFingerprint = stableHash({
      text: String(requestData.rawText || requestData.text || '')
    }, 'record-confirm-original-text');
    const sentRoute = requestData.route || requestData.routeDecision || requestData.route_decision || '';
    const event = {
      confirmationSessionId: String(
        requestData.confirmationSessionId || requestData.confirmation_session_id || ''
      ),
      draftRevision: String(requestData && (
        requestData.draftRevision || requestData.revision
      ) || ''),
      index: events.length,
      independentlyComputedFingerprint,
      method: requestOptions.method || 'POST',
      originalTextFingerprint: String(
        requestData.originalTextFingerprint || requestData.original_text_fingerprint || ''
      ),
      path,
      requestId: String(requestData.requestId || requestData.request_id || ''),
      requestData: safeClone(requestData),
      reviewMode: String(requestData.reviewMode || ''),
      route: typeof sentRoute === 'string' ? sentRoute : String(
        sentRoute.semantic_decision || sentRoute.semanticDecision || sentRoute.decision || ''
      ),
      outcome: '',
      settled: false
    };
    events.push(event);
    if (path === '/api/auth/wechat-login') {
      success(requestOptions, event, 200, {
        token: 'REDACTED_CONTROLLED_TOKEN',
        expiresAt: '2027-08-05T12:00:00.000Z'
      });
      return;
    }
    if (!['/api/ai/parse', '/api/ai/parse/deep'].includes(path)) {
      return fail(requestOptions, event, 'AUTOMATION_NETWORK_GUARD_ERROR', `unexpected path ${path}`);
    }
    if (controller.mode === 'DEFERRED') {
      event.outcome = 'DEFERRED';
      deferred.push({ event, request: requestOptions });
      return;
    }
    complete(requestOptions, event);
  }

  function releaseAt(index, override = {}) {
    const target = deferred.find((entry) => entry.event.index === index && !entry.event.settled);
    if (!target) {
      const error = new Error(`No unsettled deferred request at index ${index}`);
      error.code = 'TEST_DATA_ERROR';
      throw error;
    }
    complete(target.request, target.event, Object.assign({ mode: 'SUCCESS' }, override));
  }

  function guardHostNetwork() {
    if (guardInstalled) return;
    guardInstalled = true;
    const blocked = () => {
      realNetworkRequests += 1;
      const error = new Error('Host network forbidden by controlled fixture');
      error.code = 'AUTOMATION_NETWORK_GUARD_ERROR';
      throw error;
    };
    const remember = (target, key) => {
      originals.push({ target, key, value: target[key] });
      target[key] = blocked;
    };
    originals.push({ target: global, key: 'fetch', value: global.fetch });
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

  function aiEvents() {
    return events.filter((event) => event.path.startsWith('/api/ai/parse'));
  }

  return {
    aiEvents,
    audit() {
      return {
        controlledFixture: true,
        events: safeClone(events),
        realNetworkRequests,
        unsettledRequestCount: deferred.filter((entry) => !entry.event.settled).length
      };
    },
    guardHostNetwork,
    releaseAt,
    request,
    restoreHostNetwork,
    setMode(mode) { controller.mode = mode; },
    setResponse(response) { controller.response = safeClone(response || {}); }
  };
}

module.exports = {
  createControlledNetwork,
  pathFromUrl
};
