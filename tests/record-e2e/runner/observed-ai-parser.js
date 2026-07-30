const { AsyncLocalStorage } = require('async_hooks');
const { safeClone, stableHash } = require('../../../utils/record-state-diff');
const {
  compactRawParser,
  compactRelationReferences
} = require('./observation-semantics');

const PARSER_PATH = require.resolve('../../../utils/parser');
const AI_PARSER_PATH = require.resolve('../../../utils/ai-parser');

const hybridContext = new AsyncLocalStorage();
const pageMethodContext = new AsyncLocalStorage();
const directRawContext = new AsyncLocalStorage();

let observedAiParser = null;
let instrumentationInstalled = false;
let instrumentationInstalledBeforeAiParserLoad = false;
let hybridSequence = 0;
let rawSequence = 0;
let directSequence = 0;
const hybridInvocations = [];
const rawInvocations = [];
const directRawInvocations = [];

function compactFailure(error) {
  if (!error) return null;
  return {
    code: String(error.code || 'RAW_PARSER_INVOCATION_FAILED'),
    message: String(error.message || 'Parser invocation failed').slice(0, 240)
  };
}

function inputTextFromPayload(payload) {
  return String(payload && payload.text || '');
}

function inputFingerprint(payload, label = 'parser-input-v1') {
  return stableHash(inputTextFromPayload(payload), label);
}

function rawMessageCount(payload = {}) {
  const pasteMeta = payload.pasteMeta || {};
  const messages = payload.rawMessages || pasteMeta.rawMessages || pasteMeta.messages || [];
  return Array.isArray(messages)
    ? messages.filter((message) => String(
      message && (message.content || message.text) || ''
    ).trim()).length
    : 0;
}

function summarizeRawResult(result) {
  const compact = compactRawParser(result || {});
  return {
    businessType: compact.businessType,
    confidence: compact.confidence,
    intent: compact.intent,
    intentEvidence: compact.intentEvidence,
    missingFields: compact.missingFields,
    operation: compact.operation,
    relationReferences: compact.relationReferences,
    safetyStatus: compact.safety && compact.safety.status || ''
  };
}

function summarizeHybridResult(result) {
  return {
    businessType: String(result && result.intent || 'unknown'),
    operation: result && result.operation || null,
    relationReferences: compactRelationReferences(
      result && result.relation_references
    ),
    route: result && result.parse_route && result.parse_route.decision || '',
    source: result && result.source || ''
  };
}

function captureCallSite() {
  const stack = String(new Error().stack || '').split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('/utils/ai-parser.js:'));
  const compact = stack.map((line) => {
    const match = line.match(/^at\s+([^(]+)\s+\([^:]+:(\d+):(\d+)\)$/)
      || line.match(/^at\s+[^:]+:(\d+):(\d+)$/);
    if (!match) return line.replace(/^at\s+/, '').slice(0, 120);
    if (match.length === 4) return `${match[1].trim()}:${match[2]}`;
    return `anonymous:${match[1]}`;
  });
  return compact.slice(0, 6);
}

function rawRoleFromCallSite(callSite) {
  const joined = callSite.join('>');
  if (joined.includes('parseMessageUnitPriceCandidates')
    && joined.includes('extractLocalFieldConflicts')) {
    return 'CONVERSATION_CONFLICT_UNIT_PRICE_SCAN';
  }
  if (joined.includes('parseMessageQuantity')
    && joined.includes('extractLocalFieldConflicts')) {
    return 'CONVERSATION_CONFLICT_QUANTITY_SCAN';
  }
  if (joined.includes('parseMessageUnitPriceCandidates')
    && joined.includes('applyLatestLocalUnitPrice')) {
    return 'CONVERSATION_LATEST_UNIT_PRICE_SCAN';
  }
  if (joined.includes('parseMessageQuantity')
    && joined.includes('applyLatestLocalQuantity')) {
    return 'CONVERSATION_LATEST_QUANTITY_SCAN';
  }
  if (joined.includes('prepareHybridLocalStage')) return 'HYBRID_PRIMARY_LOCAL_PARSE';
  return 'UNCLASSIFIED_PRODUCTION_RAW_CALL';
}

function pageContextSnapshot() {
  const context = pageMethodContext.getStore();
  return context ? safeClone(context) : {
    actualPageMethods: [],
    rootPageMethod: '',
    surface: 'HEADLESS'
  };
}

function phaseFromPayload(payload = {}) {
  return payload.reviewMode === 'deep' ? 'DEEP_REVIEW' : 'INITIAL_PARSE';
}

function expectedRawCardinality(payload = {}) {
  const messageCount = rawMessageCount(payload);
  if (messageCount > 0) {
    return {
      expectedCount: 1 + (4 * messageCount),
      policy: 'DERIVED_FROM_INPUT_STRUCTURE',
      rawMessageCount: messageCount,
      rolePolicy: 'PRIMARY_PLUS_FOUR_CONVERSATION_PASSES_PER_MESSAGE'
    };
  }
  return {
    expectedCount: 1,
    policy: 'EXACTLY_ONE',
    rawMessageCount: 0,
    rolePolicy: 'HYBRID_PRIMARY_LOCAL_PARSE_ONLY'
  };
}

function installRawParserSpy() {
  const parser = require(PARSER_PATH);
  const originalParseInput = parser.parseInput;
  instrumentationInstalled = true;
  parser.parseInput = function observedProductionParseInput(payload) {
    return observeRawInvocation(payload, () => originalParseInput(payload));
  };
}

function observeRawInvocation(payload, invoke) {
  rawSequence += 1;
  const parentHybrid = hybridContext.getStore() || null;
  const parentDirect = directRawContext.getStore() || null;
  const callSite = captureCallSite();
  const rawInvocation = {
      calledFunction: 'parseInput',
      callSite,
      completed: false,
      failure: null,
      globalSequence: rawSequence,
      inputFingerprint: inputFingerprint(payload, 'raw-parser-input-v1'),
      inputKind: parentHybrid
        && inputFingerprint(payload, 'hybrid-parser-input-v1') === parentHybrid.inputFingerprint
        ? 'HYBRID_FULL_INPUT'
        : 'BUSINESS_TEXT_FRAGMENT',
      inputLength: inputTextFromPayload(payload).length,
      parentDirectRawInvocationId: parentDirect && parentDirect.directRawInvocationId || null,
      parentHybridInvocationId: parentHybrid && parentHybrid.hybridInvocationId || null,
      rawInvocationId: `raw-${rawSequence}`,
      resultSummary: null,
      role: rawRoleFromCallSite(callSite),
      sequenceInHybrid: null,
      sequenceInDirectRaw: null,
      started: true
  };
  if (parentHybrid) {
    rawInvocation.sequenceInHybrid = parentHybrid.rawInvocationIds.length + 1;
    parentHybrid.rawInvocationIds.push(rawInvocation.rawInvocationId);
  } else if (parentDirect) {
    rawInvocation.sequenceInDirectRaw = parentDirect.rawInvocationIds.length + 1;
    parentDirect.rawInvocationIds.push(rawInvocation.rawInvocationId);
  }
  rawInvocations.push(rawInvocation);
  try {
    const result = invoke();
    rawInvocation.resultSummary = summarizeRawResult(result);
    rawInvocation.completed = true;
    return result;
  } catch (error) {
    rawInvocation.failure = compactFailure(error);
    rawInvocation.completed = true;
    throw error;
  }
}

function observeHybridInvocation(payload, invoke) {
  hybridSequence += 1;
  const pageContext = pageContextSnapshot();
  const cardinality = expectedRawCardinality(payload);
  const hybridInvocation = {
      actualPageMethods: pageContext.actualPageMethods || [],
      callerAction: (pageContext.actualPageMethods || [])[0] || 'HEADLESS_PARSE',
      completed: false,
      failure: null,
      hybridInvocationId: `hybrid-${hybridSequence}`,
      inputFingerprint: inputFingerprint(payload, 'hybrid-parser-input-v1'),
      inputKind: cardinality.rawMessageCount > 0
        ? 'MULTI_MESSAGE_CLIPBOARD'
        : 'BUSINESS_TEXT',
      inputLength: inputTextFromPayload(payload).length,
      phase: phaseFromPayload(payload),
      rawCardinalityExpectation: cardinality,
      rawInvocationIds: [],
      resultSummary: null,
      sequence: hybridSequence,
      started: true,
      surface: pageContext.surface || 'HEADLESS'
  };
  hybridInvocations.push(hybridInvocation);
  const context = {
    hybridInvocationId: hybridInvocation.hybridInvocationId,
    inputFingerprint: hybridInvocation.inputFingerprint,
    rawInvocationIds: hybridInvocation.rawInvocationIds
  };
  let promise;
  try {
    promise = hybridContext.run(context, () => Promise.resolve(invoke()));
  } catch (error) {
    hybridInvocation.failure = compactFailure(error);
    hybridInvocation.completed = true;
    throw error;
  }
  return promise.then((result) => {
    hybridInvocation.resultSummary = summarizeHybridResult(result);
    return result;
  }, (error) => {
    hybridInvocation.failure = compactFailure(error);
    throw error;
  }).finally(() => {
    hybridInvocation.completed = true;
  });
}

function wrapHybridParser(aiParser) {
  const originalParseHybridInput = aiParser.parseHybridInput;
  aiParser.parseHybridInput = function observedProductionParseHybridInput(payload, dependencies) {
    return observeHybridInvocation(
      payload,
      () => originalParseHybridInput(payload, dependencies)
    );
  };
  return aiParser;
}

function loadObservedAiParser() {
  if (observedAiParser) return observedAiParser;
  installRawParserSpy();
  delete require.cache[AI_PARSER_PATH];
  observedAiParser = wrapHybridParser(require(AI_PARSER_PATH));
  instrumentationInstalledBeforeAiParserLoad = true;
  return observedAiParser;
}

function parserObservationCursor() {
  return {
    directSequence,
    hybridSequence,
    rawSequence
  };
}

function runWithPageMethodContext(details, callback) {
  const parent = pageMethodContext.getStore() || {
    actualPageMethods: [],
    rootPageMethod: '',
    surface: details.surface || ''
  };
  const actualPageMethods = parent.actualPageMethods.concat(details.methodName);
  return pageMethodContext.run({
    actualPageMethods,
    rootPageMethod: parent.rootPageMethod || details.methodName,
    surface: details.surface || parent.surface || ''
  }, callback);
}

function runDirectRawInvocation(label, callback) {
  directSequence += 1;
  const direct = {
    completed: false,
    directRawInvocationId: `direct-raw-parent-${directSequence}`,
    failure: null,
    label: String(label || 'DIRECT_RAW_INVOCATION'),
    rawInvocationIds: [],
    sequence: directSequence,
    started: true
  };
  directRawInvocations.push(direct);
  try {
    const result = directRawContext.run(direct, callback);
    if (result && typeof result.then === 'function') {
      return result.then((value) => {
        direct.completed = true;
        return value;
      }, (error) => {
        direct.failure = compactFailure(error);
        direct.completed = true;
        throw error;
      });
    }
    direct.completed = true;
    return result;
  } catch (error) {
    direct.failure = compactFailure(error);
    direct.completed = true;
    throw error;
  }
}

function observeHybridInvocationForTest(payload, callback, pageDetails = {}) {
  loadObservedAiParser();
  return runWithPageMethodContext({
    methodName: pageDetails.methodName || 'selfTestHybridAction',
    surface: pageDetails.surface || 'HEADLESS'
  }, () => observeHybridInvocation(
    payload,
    () => callback(require(PARSER_PATH).parseInput)
  ));
}

function observeRawInvocationForTest(payload, callback) {
  loadObservedAiParser();
  return runDirectRawInvocation(
    'SELF_TEST_DIRECT_RAW_INVOCATION',
    () => observeRawInvocation(payload, callback)
  );
}

function rawById(rawItems) {
  return new Map(rawItems.map((raw) => [raw.rawInvocationId, raw]));
}

function collectParserObservationSince(cursor = { directSequence: 0, hybridSequence: 0, rawSequence: 0 }) {
  const hybrids = hybridInvocations.filter((item) => item.sequence > cursor.hybridSequence);
  const directs = directRawInvocations.filter((item) => item.sequence > cursor.directSequence);
  const raws = rawInvocations.filter((item) => item.globalSequence > cursor.rawSequence);
  const rawMap = rawById(raws);
  const hybridOutput = hybrids.map((hybrid) => Object.assign({}, safeClone(hybrid), {
    rawInvocations: hybrid.rawInvocationIds
      .map((id) => rawMap.get(id))
      .filter(Boolean)
      .map(safeClone)
  }));
  const directOutput = directs.map((direct) => Object.assign({}, safeClone(direct), {
    rawInvocations: direct.rawInvocationIds
      .map((id) => rawMap.get(id))
      .filter(Boolean)
      .map(safeClone)
  }));
  const parentedIds = new Set([]
    .concat(...hybrids.map((item) => item.rawInvocationIds))
    .concat(...directs.map((item) => item.rawInvocationIds)));
  const orphanRawInvocations = raws.filter((raw) => !parentedIds.has(raw.rawInvocationId));
  return {
    collectionCompleted: true,
    directRawInvocations: directOutput,
    hybridInvocations: hybridOutput,
    instrumentationInstalled,
    instrumentationInstalledBeforeAiParserLoad,
    orphanRawInvocations: safeClone(orphanRawInvocations),
    rawInvocationCount: raws.length,
    // A Raw call without a registered Hybrid/Direct parent is orphan evidence,
    // not proof that the Runner executed a shadow parse. Shadow invocations are
    // tracked independently so the two integrity gates cannot mask one another.
    shadowParserInvocations: [],
    status: raws.some((raw) => raw.failure)
      ? 'RAW_PARSER_INVOCATION_FAILED'
      : (raws.length ? 'RAW_PARSER_INVOKED' : 'RAW_PARSER_NOT_INVOKED_BY_PRODUCTION_PATH'),
    uncorrelatedInvocationCount: orphanRawInvocations.length,
    validationCompleted: false
  };
}

function parserInstrumentationAudit() {
  const full = collectParserObservationSince();
  return {
    auditPerformed: true,
    collectionCompleted: full.collectionCompleted,
    directRawInvocationCount: full.directRawInvocations.length,
    hybridInvocationCount: full.hybridInvocations.length,
    instrumentationInstalled,
    instrumentationInstalledBeforeAiParserLoad,
    orphanRawInvocationCount: full.orphanRawInvocations.length,
    rawInvocationCount: full.rawInvocationCount,
    shadowParserInvocationCount: full.shadowParserInvocations.length,
    uncorrelatedInvocationCount: full.uncorrelatedInvocationCount
  };
}

module.exports = {
  collectParserObservationSince,
  loadObservedAiParser,
  parserInstrumentationAudit,
  parserObservationCursor,
  observeHybridInvocationForTest,
  observeRawInvocationForTest,
  runDirectRawInvocation,
  runWithPageMethodContext
};
