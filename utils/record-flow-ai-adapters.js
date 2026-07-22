const { requestHybridAiRaw } = require('./ai-parser');
const { PROVIDER_KINDS } = require('./record-flow-contract');

const existingAdapterDescriptors = new WeakMap();
const existingTransportEvents = new WeakMap();

// This compatibility adapter is deliberately outside record-flow-core because it
// reaches the current WeChat network implementation. The core only sees the
// platform-neutral parse(request, hooks) contract and a raw AI business result.
function createExistingHybridAiAdapter(options = {}) {
  const descriptor = Object.freeze({
    adapterId: options.adapterId || 'existing-wechat-hybrid-ai',
    adapterName: options.adapterName || 'existing-wechat-hybrid-ai',
    providerKind: PROVIDER_KINDS.REAL,
    provider: options.provider || '',
    model: options.model || '',
    modelTier: options.modelTier || '',
    networkAccess: true,
    supportsStandard: true,
    supportsDeep: true,
    supportsAbort: false,
    supportsUsage: false
  });
  async function parse(request, hooks = {}) {
    if (typeof hooks.onRequestStarted === 'function') hooks.onRequestStarted();
    const payload = {
      text: request.extractedText || request.originalText,
      rawText: request.originalText,
      extractedText: request.extractedText || '',
      source: request.legacyInputSource || 'typed',
      context: request.context || 'home',
      reviewMode: request.reviewMode || 'standard',
      requestId: request.requestId || '',
      businessTimezone: request.businessTimezone || 'Asia/Shanghai',
      rawMessages: request.rawMessages || [],
      pasteMeta: request.pasteMeta || null
    };
    if (request.businessDate) payload.businessDate = request.businessDate;
    if (request.nowInstant) payload.nowInstant = request.nowInstant;
    try {
      const response = await requestHybridAiRaw({
        payload,
        localResult: request.localDraft,
        route: request.routeDecision,
        scopedHistory: {
          customers: request.customerCandidates || [],
          businessContext: request.businessContext || {}
        },
        localDurationMs: request.localDurationMs || 0
      });
      const result = {
        rawResult: response.aiResult,
        requestId: request.requestId || '',
        serverRequestId: response.aiResult && response.aiResult.ai_request_id,
        latencyMs: response.aiDurationMs
      };
      existingTransportEvents.set(result, {
        adapterInvoked: true,
        requestStarted: true,
        responseReceived: true
      });
      if (typeof hooks.onResponseReceived === 'function') hooks.onResponseReceived();
      return result;
    } catch (error) {
      if (error && error.code === 'AI_ENDPOINT_MISSING') {
        existingTransportEvents.set(error, {
          adapterInvoked: false,
          requestStarted: false,
          responseReceived: false
        });
      } else if (error && error.statusCode) {
        existingTransportEvents.set(error, {
          adapterInvoked: true,
          requestStarted: true,
          responseReceived: true
        });
      } else {
        existingTransportEvents.set(error, {
          adapterInvoked: true,
          requestStarted: true,
          responseReceived: false
        });
      }
      if (error && /timeout|超时/i.test(`${error.code || ''} ${error.message || ''}`)) {
        if (typeof hooks.onTimeout === 'function') hooks.onTimeout(error);
      } else if (typeof hooks.onTransportError === 'function') {
        hooks.onTransportError(error);
      }
      throw error;
    }
  }
  const adapter = Object.freeze({
    descriptor,
    getIdentity() { return Object.assign({}, descriptor); },
    parse,
    execute: parse
  });
  existingAdapterDescriptors.set(adapter, adapter.descriptor);
  return adapter;
}

function getExistingHybridAiAdapterDescriptor(adapter) {
  return existingAdapterDescriptors.get(adapter) || null;
}

function getExistingHybridTransportEvents(value) {
  return value && typeof value === 'object' ? (existingTransportEvents.get(value) || null) : null;
}

module.exports = {
  createExistingHybridAiAdapter,
  getExistingHybridAiAdapterDescriptor,
  getExistingHybridTransportEvents
};
