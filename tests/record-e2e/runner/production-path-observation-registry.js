const { safeClone } = require('../../../utils/record-state-diff');

const PARSER_PATH_CONTRACTS = Object.freeze({
  REQUIRED: 'REQUIRED',
  BRANCH_DEPENDENT: 'BRANCH_DEPENDENT',
  NOT_APPLICABLE_BY_PRODUCTION_PATH: 'NOT_APPLICABLE_BY_PRODUCTION_PATH'
});

const PRODUCTION_PATH_OBSERVATION_REGISTRY = Object.freeze({
  'HEADLESS|TYPED_TEXT|parseHybridInput': Object.freeze({
    directRawInvocationPolicy: 'FORBIDDEN',
    hybridInvocationPolicy: 'AT_LEAST_ONE',
    parserContract: PARSER_PATH_CONTRACTS.REQUIRED,
    rawInvocationCardinality: 'DERIVED_FROM_HYBRID_INPUT_STRUCTURE',
    rawInvocationRolePolicy: 'PRIMARY_OR_CONVERSATION_REVIEW_ROLES',
    semanticResultSource: 'HEADLESS_NORMALIZED_RESULT'
  }),
  'HEADLESS|CLIPBOARD_CHAT|parseHybridInput': Object.freeze({
    directRawInvocationPolicy: 'FORBIDDEN',
    hybridInvocationPolicy: 'AT_LEAST_ONE',
    parserContract: PARSER_PATH_CONTRACTS.REQUIRED,
    rawInvocationCardinality: 'DERIVED_FROM_HYBRID_INPUT_STRUCTURE',
    rawInvocationRolePolicy: 'PRIMARY_OR_CONVERSATION_REVIEW_ROLES',
    semanticResultSource: 'HEADLESS_NORMALIZED_RESULT'
  }),
  'HEADLESS|VOICE_TRANSCRIPT|parseHybridInput': Object.freeze({
    directRawInvocationPolicy: 'FORBIDDEN',
    hybridInvocationPolicy: 'AT_LEAST_ONE',
    parserContract: PARSER_PATH_CONTRACTS.REQUIRED,
    rawInvocationCardinality: 'DERIVED_FROM_HYBRID_INPUT_STRUCTURE',
    rawInvocationRolePolicy: 'PRIMARY_OR_CONVERSATION_REVIEW_ROLES',
    semanticResultSource: 'HEADLESS_NORMALIZED_RESULT'
  }),
  'HOME_QUICK|TYPED_TEXT|submitComposer': Object.freeze({
    directRawInvocationPolicy: 'FORBIDDEN',
    hybridInvocationPolicy: 'AT_LEAST_ONE_OR_NO_BUSINESS_CONFIRMATION',
    parserContract: PARSER_PATH_CONTRACTS.BRANCH_DEPENDENT,
    rawInvocationCardinality: 'DERIVED_FROM_HYBRID_INPUT_STRUCTURE',
    rawInvocationRolePolicy: 'PRIMARY_OR_CONVERSATION_REVIEW_ROLES',
    semanticResultSource: 'PAGE_CONFIRMED_DRAFT'
  }),
  'HOME_QUICK|CLIPBOARD_CHAT|pasteClipboard': Object.freeze({
    directRawInvocationPolicy: 'FORBIDDEN',
    hybridInvocationPolicy: 'AT_LEAST_ONE_OR_NO_BUSINESS_CONFIRMATION',
    parserContract: PARSER_PATH_CONTRACTS.BRANCH_DEPENDENT,
    rawInvocationCardinality: 'DERIVED_FROM_HYBRID_INPUT_STRUCTURE',
    rawInvocationRolePolicy: 'PRIMARY_OR_CONVERSATION_REVIEW_ROLES',
    semanticResultSource: 'PAGE_CONFIRMED_DRAFT'
  }),
  'HOME_QUICK|VOICE_TRANSCRIPT|beginVoiceRecognition': Object.freeze({
    directRawInvocationPolicy: 'FORBIDDEN',
    hybridInvocationPolicy: 'AT_LEAST_ONE',
    parserContract: PARSER_PATH_CONTRACTS.REQUIRED,
    rawInvocationCardinality: 'DERIVED_FROM_HYBRID_INPUT_STRUCTURE',
    rawInvocationRolePolicy: 'PRIMARY_OR_CONVERSATION_REVIEW_ROLES',
    semanticResultSource: 'PAGE_CONFIRMED_DRAFT'
  }),
  'FULL_PAGE|TYPED_TEXT|runParse': Object.freeze({
    directRawInvocationPolicy: 'FORBIDDEN',
    hybridInvocationPolicy: 'AT_LEAST_ONE_OR_NO_BUSINESS_CONFIRMATION',
    parserContract: PARSER_PATH_CONTRACTS.BRANCH_DEPENDENT,
    rawInvocationCardinality: 'DERIVED_FROM_HYBRID_INPUT_STRUCTURE',
    rawInvocationRolePolicy: 'PRIMARY_OR_CONVERSATION_REVIEW_ROLES',
    semanticResultSource: 'PAGE_CONFIRMED_DRAFT'
  }),
  'FULL_PAGE|CLIPBOARD_CHAT|pasteClipboard': Object.freeze({
    directRawInvocationPolicy: 'FORBIDDEN',
    hybridInvocationPolicy: 'AT_LEAST_ONE_OR_NO_BUSINESS_CONFIRMATION',
    parserContract: PARSER_PATH_CONTRACTS.BRANCH_DEPENDENT,
    rawInvocationCardinality: 'DERIVED_FROM_HYBRID_INPUT_STRUCTURE',
    rawInvocationRolePolicy: 'PRIMARY_OR_CONVERSATION_REVIEW_ROLES',
    semanticResultSource: 'PAGE_CONFIRMED_DRAFT'
  }),
  'FULL_PAGE|VOICE_TRANSCRIPT|startVoice': Object.freeze({
    directRawInvocationPolicy: 'FORBIDDEN',
    hybridInvocationPolicy: 'AT_LEAST_ONE',
    parserContract: PARSER_PATH_CONTRACTS.REQUIRED,
    rawInvocationCardinality: 'DERIVED_FROM_HYBRID_INPUT_STRUCTURE',
    rawInvocationRolePolicy: 'PRIMARY_OR_CONVERSATION_REVIEW_ROLES',
    semanticResultSource: 'PAGE_CONFIRMED_DRAFT'
  }),
  'FULL_PAGE|PENDING_EDIT|runParse': Object.freeze({
    directRawInvocationPolicy: 'FORBIDDEN',
    hybridInvocationPolicy: 'AT_LEAST_ONE',
    parserContract: PARSER_PATH_CONTRACTS.REQUIRED,
    rawInvocationCardinality: 'DERIVED_FROM_HYBRID_INPUT_STRUCTURE',
    rawInvocationRolePolicy: 'PRIMARY_OR_CONVERSATION_REVIEW_ROLES',
    semanticResultSource: 'PAGE_CONFIRMED_DRAFT'
  }),
  'FULL_PAGE|HISTORY_EDIT|onShow': Object.freeze({
    directRawInvocationPolicy: 'FORBIDDEN',
    hybridInvocationPolicy: 'EXACTLY_ZERO',
    parserContract: PARSER_PATH_CONTRACTS.NOT_APPLICABLE_BY_PRODUCTION_PATH,
    rawInvocationCardinality: 'EXACTLY_ZERO',
    rawInvocationRolePolicy: 'NONE',
    semanticResultSource: 'PAGE_HISTORY_EDIT_DRAFT'
  })
});

function registryKey(entrySurface, inputChannel, actualPageMethod) {
  return [entrySurface, inputChannel, actualPageMethod].map(String).join('|');
}

function pathError(code, message, detail = {}) {
  return Object.assign(new Error(message), { code, detail });
}

function detectPageBranch(page, inputChannel, hybridInvocationCount) {
  if (hybridInvocationCount > 0) return 'HYBRID_INVOCATION';
  const data = page && page.data || {};
  const pasteAnalysis = data.pasteAnalysis || {};
  const parseResult = data.parseResult || {};
  const noBusinessPaste = data.parseResult && (
    inputChannel === 'CLIPBOARD_CHAT'
      ? Boolean(pasteAnalysis.status && pasteAnalysis.status !== 'ok')
      : (
        parseResult.source === 'paste'
        && parseResult.parse_route
        && parseResult.parse_route.decision === 'no_record'
      )
  );
  if (noBusinessPaste) {
    return 'CLIPBOARD_NO_BUSINESS_CONFIRMATION';
  }
  if (inputChannel === 'HISTORY_EDIT' && data.parseResult) {
    return 'HISTORY_EDIT_DRAFT';
  }
  return 'UNRESOLVED_ZERO_INVOCATION';
}

function resolveProductionPathObservation({
  actualPageMethod,
  entrySurface,
  hybridInvocationCount,
  inputChannel,
  rawInvocationCount,
  page
}) {
  const key = registryKey(entrySurface, inputChannel, actualPageMethod);
  const registered = PRODUCTION_PATH_OBSERVATION_REGISTRY[key];
  if (!registered) {
    throw pathError(
      'PRODUCTION_PATH_OBSERVATION_CONTRACT_MISSING',
      `Production path observation contract missing: ${key}`,
      { key }
    );
  }
  const productionBranch = entrySurface === 'HEADLESS'
    ? 'HYBRID_INVOCATION'
    : detectPageBranch(page, inputChannel, hybridInvocationCount);
  let parserInvocationExpected = registered.parserContract === PARSER_PATH_CONTRACTS.REQUIRED;
  let parserInvocationNotApplicable = registered.parserContract
    === PARSER_PATH_CONTRACTS.NOT_APPLICABLE_BY_PRODUCTION_PATH;
  if (registered.parserContract === PARSER_PATH_CONTRACTS.BRANCH_DEPENDENT) {
    if (productionBranch === 'HYBRID_INVOCATION') parserInvocationExpected = true;
    if (productionBranch === 'CLIPBOARD_NO_BUSINESS_CONFIRMATION') {
      parserInvocationNotApplicable = true;
    }
  }
  return {
    actualPageMethod,
    directRawInvocationPolicy: registered.directRawInvocationPolicy,
    entrySurface,
    hybridInvocationCount,
    hybridInvocationPolicy: registered.hybridInvocationPolicy,
    inputChannel,
    parserContract: registered.parserContract,
    parserInvocationExpected,
    parserInvocationNotApplicable,
    productionBranch,
    productionPath: `${key}:${productionBranch}`,
    rawInvocationCardinality: registered.rawInvocationCardinality,
    rawInvocationCount,
    rawInvocationRolePolicy: registered.rawInvocationRolePolicy,
    registryKey: key,
    semanticResultSource: registered.semanticResultSource,
    source: 'PRODUCTION_PATH_OBSERVATION_REGISTRY',
    zeroInvocationResolved: hybridInvocationCount > 0
      || parserInvocationNotApplicable === true
  };
}

function listProductionPathContracts() {
  return Object.keys(PRODUCTION_PATH_OBSERVATION_REGISTRY).sort().map((key) => ({
    key,
    contract: safeClone(PRODUCTION_PATH_OBSERVATION_REGISTRY[key])
  }));
}

module.exports = {
  PARSER_PATH_CONTRACTS,
  PRODUCTION_PATH_OBSERVATION_REGISTRY,
  listProductionPathContracts,
  registryKey,
  resolveProductionPathObservation
};
