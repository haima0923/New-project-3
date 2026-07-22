const { requestHybridAiRaw } = require('./ai-parser');
const { PROVIDER_KINDS } = require('./record-flow-contract');

const existingAdapterDescriptors = new WeakMap();
const existingTransportEvents = new WeakMap();

// This compatibility adapter is deliberately outside record-flow-core because it
// reaches the current WeChat network implementation. The core only sees the
// platform-neutral execute(request) contract and a raw AI business result.
function createExistingHybridAiAdapter(options = {}) {
  const adapter = Object.freeze({
    descriptor: Object.freeze({
      adapterId: options.adapterId || 'existing-wechat-hybrid-ai',
      providerKind: PROVIDER_KINDS.REAL,
      provider: options.provider || '',
      model: options.model || '',
      modelTier: options.modelTier || '',
      networkAccess: true
    }),
    async execute(request) {
      const payload = {
        text: request.extractedText || request.originalText,
        rawText: request.originalText,
        extractedText: request.extractedText || '',
        source: request.legacyInputSource || 'typed',
        context: request.context || 'home',
        reviewMode: request.reviewMode || 'standard',
        rawMessages: request.rawMessages || [],
        pasteMeta: request.pasteMeta || null
      };
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
          requestId: response.aiResult && response.aiResult.ai_request_id,
          latencyMs: response.aiDurationMs
        };
        existingTransportEvents.set(result, {
          adapterInvoked: true,
          requestStarted: true,
          responseReceived: true
        });
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
        throw error;
      }
    }
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
