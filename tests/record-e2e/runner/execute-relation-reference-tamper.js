const {
  evaluateRecordDomainPreflight
} = require('../../../utils/record-domain-preflight');
const {
  collectChangedPaths,
  safeClone,
  stableHash
} = require('../../../utils/record-state-diff');

function blockingCodes(preflight) {
  return (preflight && preflight.blockingIssues || []).map((item) => item.code);
}

function setQuotationReference(draft, injectedId) {
  const next = safeClone(draft || {});
  next.fields = Object.assign({}, next.fields || {});
  if (Object.prototype.hasOwnProperty.call(next.fields, 'quotationId')) {
    throw Object.assign(new Error('Security test draft already contains quotationId'), {
      code: 'TEST_DATA_ERROR',
      failureCode: 'RELATION_TAMPER_REFERENCE_PREINJECTED'
    });
  }
  next.fields.quotationId = String(injectedId || '');
  return next;
}

function executeRelationReferenceTamper(spec, state) {
  const contract = spec.execution && spec.execution.relationReferenceTamper;
  if (!contract
    || contract.sourceDraft !== 'EXPLICIT_SECURITY_TEST_DRAFT'
    || contract.relationKind !== 'QUOTATION'
    || contract.targetPath !== 'fields.quotationId'
    || !contract.injectedId) {
    throw Object.assign(new Error('Relation tamper execution contract is incomplete'), {
      code: 'TEST_DATA_ERROR',
      failureCode: 'RELATION_TAMPER_CONTRACT_INVALID'
    });
  }
  const currentState = safeClone(state || {});
  const draftBeforeInjection = safeClone(contract.baseDraft || {});
  const draftAfterInjection = setQuotationReference(
    draftBeforeInjection,
    contract.injectedId
  );
  const changedPaths = collectChangedPaths(
    draftBeforeInjection,
    draftAfterInjection
  );
  if (changedPaths.length !== 1 || changedPaths[0] !== 'fields.quotationId') {
    throw Object.assign(new Error('Relation tamper changed fields outside quotationId'), {
      code: 'AUTOMATION_DRIVER_ERROR',
      failureCode: 'RELATION_TAMPER_MUTATION_SCOPE_VIOLATION'
    });
  }
  const preflight = evaluateRecordDomainPreflight({
    aiOutcome: 'NOT_REQUESTED',
    businessDate: spec.clock.businessDate,
    businessType: draftAfterInjection.intent,
    finalResult: draftAfterInjection,
    initialState: currentState,
    mode: 'PRODUCTION_ROUTING',
    operation: draftAfterInjection.operation,
    originalText: draftAfterInjection.original_text,
    providerKind: 'NONE',
    resultScope: 'PRODUCTION_RESULT',
    selectedCustomerId: contract.preflightContext.selectedCustomerId,
    selectedQuotationId: contract.injectedId,
    skipFinalSafety: true
  });
  const quotationSelectionCandidates = safeClone(
    preflight.candidates && preflight.candidates.quotationSelectionCandidates || []
  );
  const rejectedQuotationReferences = safeClone(
    preflight.candidates && preflight.candidates.rejectedQuotationReferences || []
  );
  return {
    allowedMutationPaths: ['fields.quotationId'],
    blockingCodes: blockingCodes(preflight),
    candidateIds: quotationSelectionCandidates.map((item) => (
      String(item.quotationId || item.id || '')
    )),
    domainCanSaveFormal: preflight.domainCanSaveFormal === true,
    draftAfterFingerprint: stableHash(draftAfterInjection, 'relation-tamper-after-v1'),
    draftAfterInjection,
    draftBeforeFingerprint: stableHash(draftBeforeInjection, 'relation-tamper-before-v1'),
    draftBeforeInjection,
    injectedReferenceExcludedFromSafeCandidates: !quotationSelectionCandidates
      .some((item) => String(item.quotationId || item.id || '') === String(contract.injectedId)),
    injectedRelation: {
      id: String(contract.injectedId),
      kind: contract.relationKind,
      targetPath: contract.targetPath
    },
    mutationPaths: changedPaths,
    preflightAfterInjection: safeClone(preflight),
    preflightContext: safeClone(contract.preflightContext),
    rejectedQuotationReferences,
    sourceDraft: contract.sourceDraft
  };
}

module.exports = {
  executeRelationReferenceTamper,
  setQuotationReference
};
