const { safeClone, stableHash } = require('../../../utils/record-state-diff');
const { analyzeClipboardText, getPasteMeta } = require('../../../utils/clipboard-chat');
const { businessDraftPayload } = require('./page-vm-driver');
const { routeFromResult } = require('./execute-page-observation');
const {
  collectParserObservationSince,
  loadObservedAiParser,
  parserObservationCursor
} = require('./observed-ai-parser');
const {
  resolveProductionPathObservation
} = require('./production-path-observation-registry');
const {
  validateParserInvocationGraph
} = require('./validate-parser-invocation-graph');

function adaptTransportIdentity(result, profile) {
  if (!['FAKE_STANDARD', 'FAKE_DEEP', 'REPLAY'].includes(profile)) {
    return { result, adaptation: null };
  }
  const fallback = result && result.ai_fallback || {};
  if (fallback.status !== 'used' || fallback.business_result_valid !== true) {
    return { result, adaptation: null };
  }
  const beforeHash = stableHash(businessDraftPayload(result), 'page-draft-business-v1');
  const providerKind = profile === 'REPLAY' ? 'REPLAY' : 'FAKE';
  const adapted = Object.assign({}, result, {
    ai_fallback: Object.assign({}, fallback, { provider_kind: providerKind })
  });
  const afterHash = stableHash(businessDraftPayload(adapted), 'page-draft-business-v1');
  return {
    adaptation: {
      marker: 'TEST_ONLY_TRANSPORT_IDENTITY_ADAPTATION',
      from: String(fallback.provider_kind || 'REAL'),
      to: providerKind,
      businessHashBefore: beforeHash,
      businessHashAfter: afterHash,
      businessHashEqual: beforeHash === afterHash
    },
    result: adapted
  };
}

async function executeHeadlessObservation(spec) {
  let text = spec.input.originalText;
  let source = 'typed';
  let analysis = null;
  if (spec.input.channel === 'CLIPBOARD_CHAT') {
    analysis = analyzeClipboardText(spec.input.clipboardText || spec.input.originalText);
    text = analysis.extractedText || text;
    source = 'paste';
  } else if (spec.input.channel === 'VOICE_TRANSCRIPT') {
    text = spec.input.voiceTranscript || text;
    source = 'voice';
  }
  const payload = {
    businessDate: spec.clock.businessDate,
    businessTimezone: spec.clock.timezone,
    nowInstant: spec.clock.nowInstant,
    context: 'home',
    reviewMode: spec.ai.profile === 'FAKE_DEEP' ? 'deep' : 'standard',
    source,
    state: safeClone(spec.initialState.state),
    text
  };
  if (analysis) {
    payload.rawText = analysis.rawText;
    payload.extractedText = analysis.extractedText;
    payload.pasteMeta = getPasteMeta(analysis);
  }
  const aiParser = loadObservedAiParser();
  const parserCursor = parserObservationCursor();
  let original;
  let parserObservation;
  let productionPathObservation;
  try {
    original = await aiParser.parseHybridInput(payload);
  } catch (error) {
    parserObservation = collectParserObservationSince(parserCursor);
    try {
      productionPathObservation = resolveProductionPathObservation({
        actualPageMethod: 'parseHybridInput',
        entrySurface: 'HEADLESS',
        inputChannel: spec.input.channel,
        hybridInvocationCount: parserObservation.hybridInvocations.length,
        rawInvocationCount: parserObservation.rawInvocationCount,
        page: null
      });
      parserObservation = validateParserInvocationGraph(
        parserObservation,
        productionPathObservation
      );
    } catch (collectionError) {
      error.parserObservationCollectionFailure = {
        code: collectionError.code || 'RAW_PARSER_EVIDENCE_MISSING',
        message: collectionError.message
      };
    }
    error.parserObservation = safeClone(parserObservation);
    error.productionPathObservation = safeClone(productionPathObservation || null);
    throw error;
  }
  parserObservation = collectParserObservationSince(parserCursor);
  productionPathObservation = resolveProductionPathObservation({
    actualPageMethod: 'parseHybridInput',
    entrySurface: 'HEADLESS',
    inputChannel: spec.input.channel,
    hybridInvocationCount: parserObservation.hybridInvocations.length,
    rawInvocationCount: parserObservation.rawInvocationCount,
    page: null
  });
  parserObservation = validateParserInvocationGraph(
    parserObservation,
    productionPathObservation
  );
  const adapted = adaptTransportIdentity(original, spec.ai.profile);
  const result = adapted.result;
  return {
    actualInput: {
      channel: spec.input.channel,
      originalText: spec.input.originalText,
      pageText: null,
      source
    },
    afterEdits: {
      surface: 'HEADLESS',
      originalInput: spec.input.originalText,
      parseResult: safeClone(result),
      fields: safeClone(result.fields || {}),
      items: safeClone(result.fields && result.fields.items || []),
      missingFields: safeClone(result.missing_fields || []),
      conflictFields: safeClone((result.field_conflicts || []).map((item) => (
        typeof item === 'string' ? item : item && item.field
      )).filter(Boolean)),
      blockingCodes: [],
      draftBusinessHash: stableHash(businessDraftPayload(result), 'page-draft-business-v1')
    },
    beforeEdits: null,
    driver: null,
    inputBefore: null,
    interaction: { evidence: { edits: [], selections: [] }, failures: [] },
    missingCapabilities: [],
    route: routeFromResult(result),
    parserObservation,
    productionPathObservation,
    transportIdentityAdaptation: adapted.adaptation
  };
}

module.exports = {
  executeHeadlessObservation
};
