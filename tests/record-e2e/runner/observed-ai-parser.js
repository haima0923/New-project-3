const { compactRawParser } = require('./observation-semantics');

const PARSER_PATH = require.resolve('../../../utils/parser');
const AI_PARSER_PATH = require.resolve('../../../utils/ai-parser');

let observedAiParser = null;
const rawParserInvocations = [];

function loadObservedAiParser() {
  if (observedAiParser) return observedAiParser;
  const parser = require(PARSER_PATH);
  const originalParseInput = parser.parseInput;
  parser.parseInput = function observedProductionParseInput(payload) {
    const result = originalParseInput(payload);
    rawParserInvocations.push({
      inputText: String(payload && payload.text || ''),
      result: Object.assign(compactRawParser(result), {
        sameHybridInvocation: true
      }),
      sameHybridInvocation: true,
      source: 'PRODUCTION_LOCAL_PARSER'
    });
    return result;
  };
  delete require.cache[AI_PARSER_PATH];
  try {
    observedAiParser = require(AI_PARSER_PATH);
  } finally {
    parser.parseInput = originalParseInput;
  }
  return observedAiParser;
}

function rawParserCursor() {
  return rawParserInvocations.length;
}

function takeRawParserInvocation(cursor) {
  const calls = rawParserInvocations.slice(cursor);
  if (calls.length !== 1) {
    throw Object.assign(new Error(
      `Expected one local parser invocation inside parseHybridInput, received ${calls.length}`
    ), {
      code: 'LANE_EXECUTION_EVIDENCE_MISSING',
      observedRawParserInvocationCount: calls.length
    });
  }
  return calls[0];
}

module.exports = {
  loadObservedAiParser,
  rawParserCursor,
  takeRawParserInvocation
};
