const { safeClone } = require('../../../utils/record-state-diff');
const {
  RAW_PARSER_STATUSES,
  graphErrors
} = require('./validate-parser-invocation-graph');

const OBSERVATION_CONTRACT_VERSION = 'record-e2e-observation-semantics-v1';
const FORMAL_COLLECTION_TYPES = Object.freeze({
  orders: 'order',
  payments: 'payment',
  quotations: 'quotation',
  receivables: 'receivable',
  todos: 'todo'
});

function normalizeRawOperation(value) {
  return value === undefined || value === null || value === '' ? null : String(value);
}

function compactRelationReferences(value) {
  const references = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
  const order = references.order && typeof references.order === 'object'
    && !Array.isArray(references.order)
    ? references.order
    : null;
  if (!order) return {};
  return {
    order: {
      confidence: Number.isFinite(Number(order.confidence))
        ? Number(order.confidence)
        : null,
      entityType: String(order.entityType || ''),
      evidenceSource: String(order.evidenceSource || ''),
      explicit: order.explicit === true,
      kind: String(order.kind || ''),
      normalizedReference: String(order.normalizedReference || ''),
      requiresResolution: order.requiresResolution === true,
      resolvedEntityId: order.resolvedEntityId === null
        ? null
        : String(order.resolvedEntityId || ''),
      sourceSpan: {
        start: Number.isFinite(Number(order.sourceSpan && order.sourceSpan.start))
          ? Number(order.sourceSpan.start)
          : null,
        end: Number.isFinite(Number(order.sourceSpan && order.sourceSpan.end))
          ? Number(order.sourceSpan.end)
          : null
      },
      sourceText: String(order.sourceText || ''),
      sourceField: String(order.sourceField || '')
    }
  };
}

function compactRawParser(result = {}) {
  return {
    businessType: String(result.intent || 'unknown'),
    confidence: result.confidence === undefined ? null : Number(result.confidence),
    intent: String(result.intent || 'unknown'),
    missingFields: safeClone(result.missing_fields || []),
    operation: normalizeRawOperation(result.operation),
    relationReferences: compactRelationReferences(result.relation_references),
    safety: safeClone(result.local_parse_safety || result.final_parse_safety || {}),
    source: 'PRODUCTION_LOCAL_PARSER'
  };
}

function rawParserObservationErrors(observation) {
  return Array.from(new Set(
    graphErrors(observation).map((error) => error.code)
  ));
}

function canonicalSemanticResult(preflight = {}, context = {}) {
  const domainBusinessType = String(preflight.businessType || 'unknown');
  const domainOperation = String(preflight.operation || 'pending');
  if (domainBusinessType === 'dunning' && domainOperation === 'create_todo') {
    return {
      businessType: 'todo',
      domainBusinessType,
      domainOperation,
      effectiveOperation: 'create_todo',
      source: 'DOMAIN_PREFLIGHT_ALIAS'
    };
  }
  if (['pending', 'unknown'].includes(domainBusinessType) && domainOperation === 'pending') {
    return {
      businessType: 'unknown',
      domainBusinessType,
      domainOperation,
      effectiveOperation: context.route === 'NO_RECORD' ? 'none' : 'unresolved',
      source: 'DOMAIN_PREFLIGHT_ALIAS'
    };
  }
  return {
    businessType: domainBusinessType,
    domainBusinessType,
    domainOperation,
    effectiveOperation: domainOperation,
    source: 'DOMAIN_PREFLIGHT'
  };
}

function proposalFromDraft(draft = {}, semanticResult = {}, surface = '') {
  const fields = safeClone(draft.fields || {});
  let businessType = String(draft.intent || semanticResult.businessType || 'unknown');
  if (businessType === 'dunning') businessType = 'todo';
  if (businessType === 'pending') {
    businessType = String(fields.proposedBusinessType || semanticResult.businessType || 'unknown');
  }
  let operation = normalizeRawOperation(draft.operation);
  let operationSource = 'DRAFT_OPERATION';
  if (!operation || operation === 'pending') {
    const suggestedOperation = normalizeRawOperation(draft.suggested_operation);
    if (suggestedOperation && suggestedOperation !== 'pending') {
      operation = suggestedOperation;
      operationSource = 'DRAFT_SUGGESTED_OPERATION';
    } else {
      operation = semanticResult.effectiveOperation || 'unresolved';
      operationSource = 'DOMAIN_PREFLIGHT_EFFECTIVE_OPERATION';
    }
  }
  return {
    businessType,
    operation,
    originalText: draft.original_text || draft.originalText || '',
    fields,
    items: safeClone(fields.items || []),
    operationSource,
    source: surface === 'HEADLESS'
      ? 'HEADLESS_NORMALIZED_RESULT'
      : 'PAGE_CONFIRMED_DRAFT'
  };
}

function changedRecords(diff = {}, collection) {
  const entry = diff[collection] || {};
  return []
    .concat((entry.created || []).map((record) => ({ change: 'CREATED', record })))
    .concat((entry.updated || []).map((item) => ({
      change: 'UPDATED',
      record: item && item.after
    })));
}

function persistedRecordsFromDiff(businessDiff = {}) {
  return Object.keys(FORMAL_COLLECTION_TYPES).flatMap((collection) => (
    changedRecords(businessDiff, collection).map((item) => ({
      change: item.change,
      collection,
      id: item.record && item.record.id || '',
      recordType: FORMAL_COLLECTION_TYPES[collection]
    }))
  )).concat(changedRecords(businessDiff, 'pendingNotes').map((item) => ({
    change: item.change,
    collection: 'pendingNotes',
    id: item.record && item.record.id || '',
    recordType: 'pending_note'
  })));
}

function actualOutcome({
  businessDiff = {},
  isolatedCommitEvidence = null,
  requestedSaveAction = '',
  route = ''
} = {}) {
  const persistedRecords = persistedRecordsFromDiff(businessDiff);
  const persistedRecordTypes = Array.from(new Set(
    persistedRecords.map((item) => item.recordType)
  )).sort();
  const committed = Boolean(
    isolatedCommitEvidence && isolatedCommitEvidence.committed === true
  );
  const pendingSaveSucceeded = committed
    && requestedSaveAction === 'SAVE_PENDING'
    && persistedRecordTypes.includes('pending_note');
  const formalTypes = persistedRecordTypes.filter((item) => item !== 'pending_note');
  const formalSaveSucceeded = committed
    && requestedSaveAction === 'SAVE_FORMAL'
    && formalTypes.length > 0;
  let disposition = 'BLOCKED';
  if (pendingSaveSucceeded) disposition = 'PENDING_NOTE';
  else if (formalSaveSucceeded) disposition = 'FORMAL_RECORD';
  else if (route === 'NO_RECORD' && persistedRecords.length === 0 && !committed) {
    disposition = 'NO_RECORD';
  }
  return {
    commitStatus: isolatedCommitEvidence && isolatedCommitEvidence.commitResult
      && isolatedCommitEvidence.commitResult.status || '',
    disposition,
    formalSaveSucceeded,
    pendingSaveSucceeded,
    persistedRecordType: persistedRecordTypes.length === 1
      ? persistedRecordTypes[0]
      : (persistedRecordTypes.length > 1 ? 'multiple' : null),
    persistedRecordTypes,
    persistedRecords,
    source: 'STATE_DIFF_AND_COMMIT'
  };
}

function observationContract(testCase) {
  return testCase.expected.observationSemantics || null;
}

function expectedRawParser(testCase) {
  const contract = observationContract(testCase);
  return contract ? contract.rawParser : (testCase.expected.rawParser || null);
}

function expectedProposal(testCase) {
  const contract = observationContract(testCase);
  return contract ? contract.proposal.result : testCase.expected.result;
}

function expectedSemanticResult(testCase) {
  const contract = observationContract(testCase);
  if (contract) return contract.semanticResult;
  const result = testCase.expected.result;
  return {
    businessType: result.businessType,
    effectiveOperation: result.operation
  };
}

function recordTypesFromExpectedDiff(testCase) {
  const collections = testCase.expected.stateDiff
    && testCase.expected.stateDiff.business
    && testCase.expected.stateDiff.business.collections || {};
  const types = [];
  Object.keys(FORMAL_COLLECTION_TYPES).forEach((collection) => {
    const entry = collections[collection] || {};
    if (Number(entry.createdCount || 0) + Number(entry.updatedCount || 0) > 0) {
      types.push(FORMAL_COLLECTION_TYPES[collection]);
    }
  });
  const pending = collections.pendingNotes || {};
  if (Number(pending.createdCount || 0) + Number(pending.updatedCount || 0) > 0) {
    types.push('pending_note');
  }
  return Array.from(new Set(types)).sort();
}

function expectedOutcome(testCase) {
  const contract = observationContract(testCase);
  if (contract) return contract.outcome;
  const status = testCase.expected.save.status;
  const recordTypes = recordTypesFromExpectedDiff(testCase);
  const disposition = {
    BLOCKED: 'BLOCKED',
    FORMAL_COMMITTED: 'FORMAL_RECORD',
    NO_RECORD: 'NO_RECORD',
    PENDING_COMMITTED: 'PENDING_NOTE'
  }[status];
  return {
    disposition,
    formalSaveSucceeded: status === 'FORMAL_COMMITTED',
    pendingSaveSucceeded: status === 'PENDING_COMMITTED',
    persistedRecordType: recordTypes.length === 1
      ? recordTypes[0]
      : (recordTypes.length > 1 ? 'multiple' : null)
  };
}

module.exports = {
  OBSERVATION_CONTRACT_VERSION,
  RAW_PARSER_STATUSES,
  actualOutcome,
  canonicalSemanticResult,
  compactRelationReferences,
  compactRawParser,
  expectedOutcome,
  expectedProposal,
  expectedRawParser,
  expectedSemanticResult,
  normalizeRawOperation,
  observationContract,
  persistedRecordsFromDiff,
  proposalFromDraft,
  rawParserObservationErrors
};
