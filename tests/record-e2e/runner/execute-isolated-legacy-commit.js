const { saveConfirmedDraft, savePendingNote } = require('../../../utils/business');
const {
  evaluateRecordDomainPreflight,
  getTrustedRecordFlowContext
} = require('../../../utils/record-domain-preflight');
const { applyFinalParseSafety } = require('../../../utils/parse-safety');
const { createStateDiff, safeClone, stableHash } = require('../../../utils/record-state-diff');
const { createFakeStorageGateway } = require('../../../utils/record-storage-gateways');
const {
  RECORD_STORAGE_BACKUP_KEY,
  RECORD_STORAGE_JOURNAL_KEY
} = require('../../../utils/record-storage-transaction-contract');
const {
  createInitialState,
  createReleaseAStorageFacade
} = require('../../../utils/storage');
const { BUSINESS_STORAGE_KEY } = require('./constants');
const { businessDraftPayload } = require('./page-vm-driver');

const PROVIDER_ONLY_BLOCK = 'UNTRUSTED_AI_PROVIDER_FOR_PRODUCTION';

function evaluateDraftPreflight(draft, state) {
  const reviewed = applyFinalParseSafety(draft || {});
  const context = getTrustedRecordFlowContext(reviewed);
  return evaluateRecordDomainPreflight({
    mode: context.mode || 'PRODUCTION_ROUTING',
    resultScope: context.resultScope || 'PRODUCTION_RESULT',
    operation: reviewed.operation,
    businessType: reviewed.intent,
    finalResult: reviewed,
    originalText: reviewed.original_text || reviewed.originalText || '',
    initialState: state,
    aiOutcome: context.aiOutcome || (reviewed.ai_fallback || {}).status || 'not_requested',
    providerKind: context.providerKind || (reviewed.ai_fallback || {}).provider_kind || 'NONE',
    skipFinalSafety: true
  });
}

function stripTestAiExecutionMetadata(draft) {
  const next = safeClone(draft || {});
  [
    'ai_fallback',
    'ai_business_result_valid',
    'parse_route',
    'parse_trace',
    'provider',
    'record_flow_context'
  ].forEach((key) => { delete next[key]; });
  return next;
}

function businessHash(draft) {
  return stableHash(businessDraftPayload(draft), 'isolated-legacy-business-v1');
}

function prepareLegacyDraft(pageDraft, initialState, profile) {
  const original = safeClone(pageDraft || {});
  const productionPreflight = evaluateDraftPreflight(original, initialState);
  const blockingCodes = (productionPreflight.blockingIssues || []).map((item) => item.code);
  const nonProviderBlocks = blockingCodes.filter((code) => code !== PROVIDER_ONLY_BLOCK);
  const fallback = original.ai_fallback || {};
  const identityBypassNeeded = ['FAKE_STANDARD', 'FAKE_DEEP', 'REPLAY'].includes(profile)
    && fallback.status === 'used'
    && ['FAKE', 'REPLAY'].includes(String(fallback.provider_kind || '').toUpperCase());
  if (nonProviderBlocks.length || (!productionPreflight.domainCanSaveFormal && !identityBypassNeeded)) {
    return {
      allowed: false,
      blockingCodes,
      businessHashBefore: businessHash(original),
      businessHashAfter: businessHash(original),
      draft: original,
      productionPreflight,
      reason: 'BUSINESS_SAFETY_BLOCKED'
    };
  }
  if (identityBypassNeeded && (
    blockingCodes.length !== 1 || blockingCodes[0] !== PROVIDER_ONLY_BLOCK
  )) {
    return {
      allowed: false,
      blockingCodes,
      businessHashBefore: businessHash(original),
      businessHashAfter: businessHash(original),
      draft: original,
      productionPreflight,
      reason: 'TEST_IDENTITY_NOT_ONLY_BLOCK'
    };
  }
  const executionDraft = identityBypassNeeded
    ? stripTestAiExecutionMetadata(original)
    : original;
  const beforeHash = businessHash(original);
  const afterHash = businessHash(executionDraft);
  if (beforeHash !== afterHash) {
    throw Object.assign(new Error('Test identity removal changed business fields'), {
      code: 'AUTOMATION_DRIVER_ERROR'
    });
  }
  const executionPreflight = evaluateDraftPreflight(executionDraft, initialState);
  if (!executionPreflight.domainCanSaveFormal) {
    return {
      allowed: false,
      blockingCodes: (executionPreflight.blockingIssues || []).map((item) => item.code),
      businessHashBefore: beforeHash,
      businessHashAfter: afterHash,
      draft: executionDraft,
      executionPreflight,
      productionPreflight,
      reason: 'BUSINESS_SAFETY_RECHECK_BLOCKED'
    };
  }
  return {
    allowed: true,
    blockingCodes,
    businessHashBefore: beforeHash,
    businessHashAfter: afterHash,
    draft: executionDraft,
    executionPreflight,
    identityBypass: identityBypassNeeded
      ? {
        marker: 'TEST_ONLY_PROVIDER_IDENTITY_REMOVAL',
        removedControlFields: [
          'ai_fallback',
          'ai_business_result_valid',
          'parse_route',
          'parse_trace',
          'provider',
          'record_flow_context'
        ],
        providerWasNeverSetToReal: true
      }
      : null,
    productionPreflight
  };
}

function makeClock(nowInstant) {
  return { now: () => new Date(nowInstant) };
}

function storageAudit(gateway, result) {
  const entries = gateway.getEntries();
  const bundle = entries[BUSINESS_STORAGE_KEY] || {};
  const control = bundle.__hxlRecordStorageV1 || {};
  return {
    backupPresent: Object.prototype.hasOwnProperty.call(entries, RECORD_STORAGE_BACKUP_KEY),
    gatewayStats: gateway.getStats(),
    journalPresent: Object.prototype.hasOwnProperty.call(entries, RECORD_STORAGE_JOURNAL_KEY),
    receiptCount: (control.recentReceipts || []).length,
    revision: Number(control.storageRevision || 0),
    transactionStatus: result && result.status || '',
    entries
  };
}

function executeFormalCommit(spec, pageDraft, options = {}) {
  const gateway = options.gateway || createFakeStorageGateway({
    [BUSINESS_STORAGE_KEY]: safeClone(spec.initialState.state)
  });
  if (typeof options.registerGateway === 'function') {
    options.registerGateway('ISOLATED_FORMAL', gateway);
  }
  const facade = options.facade || createReleaseAStorageFacade({
    clock: makeClock(spec.clock.nowInstant),
    gateway
  });
  const state = options.state || facade.getState({ writerSource: 'INPUT_FORMAL' });
  const before = safeClone(state);
  const prepared = prepareLegacyDraft(pageDraft, state, spec.ai.profile);
  if (!prepared.allowed) {
    return {
      committed: false,
      diff: createStateDiff(before, before),
      gateway,
      marker: 'TEST_ONLY_ISOLATED_COMMIT',
      prepared,
      reason: prepared.reason,
      stateAfter: before,
      stateBefore: before,
      storageAudit: storageAudit(gateway, null)
    };
  }
  const businessResult = saveConfirmedDraft(state, prepared.draft);
  if (options.skipSaveEntry === true) {
    return {
      businessResult,
      committed: false,
      diff: createStateDiff(before, state),
      gateway,
      marker: 'TEST_ONLY_ISOLATED_COMMIT',
      prepared,
      reason: 'SAVE_ENTRY_SKIPPED',
      stateAfter: safeClone(state),
      stateBefore: before,
      storageAudit: storageAudit(gateway, null)
    };
  }
  facade.saveState(state, {
    idempotencyKey: options.idempotencyKey || `e2e:${spec.caseId}:idempotency`,
    planId: options.planId || `e2e:${spec.caseId}:plan`,
    transactionId: options.transactionId || `e2e:${spec.caseId}:transaction`,
    writerSource: options.writerSource || 'INPUT_FORMAL'
  });
  const after = facade.getState({ writerSource: 'INPUT_FORMAL' });
  const commitResult = facade.getLastWriteResult();
  return {
    businessResult,
    commitResult,
    committed: Boolean(commitResult && commitResult.commitSucceeded),
    diff: createStateDiff(before, after),
    facade,
    gateway,
    marker: 'TEST_ONLY_ISOLATED_COMMIT',
    prepared,
    stateAfter: safeClone(after),
    stateBefore: before,
    storageAudit: storageAudit(gateway, commitResult)
  };
}

function executePendingCommit(spec, pageDraft, options = {}) {
  const gateway = createFakeStorageGateway({
    [BUSINESS_STORAGE_KEY]: safeClone(spec.initialState.state)
  });
  if (typeof options.registerGateway === 'function') {
    options.registerGateway('ISOLATED_PENDING', gateway);
  }
  const facade = createReleaseAStorageFacade({
    clock: makeClock(spec.clock.nowInstant),
    gateway
  });
  const state = facade.getState({ writerSource: 'INPUT_PENDING' });
  const before = safeClone(state);
  savePendingNote(state, pageDraft, '用户选择稍后整理');
  facade.saveState(state, {
    idempotencyKey: `e2e:${spec.caseId}:pending:idempotency`,
    planId: `e2e:${spec.caseId}:pending:plan`,
    transactionId: `e2e:${spec.caseId}:pending:transaction`,
    writerSource: 'INPUT_PENDING'
  });
  const after = facade.getState({ writerSource: 'INPUT_PENDING' });
  const commitResult = facade.getLastWriteResult();
  return {
    commitResult,
    committed: true,
    diff: createStateDiff(before, after),
    facade,
    gateway,
    marker: 'TEST_ONLY_ISOLATED_COMMIT',
    prepared: {
      allowed: true,
      businessHashBefore: businessHash(pageDraft),
      businessHashAfter: businessHash(pageDraft),
      identityBypass: null
    },
    stateAfter: safeClone(after),
    stateBefore: before,
    storageAudit: storageAudit(gateway, commitResult)
  };
}

function executeIsolatedLegacyCommit(spec, pageDraft, options = {}) {
  if (spec.interaction.requestedSaveAction === 'SAVE_PENDING') {
    return executePendingCommit(spec, pageDraft, options);
  }
  if (spec.interaction.requestedSaveAction !== 'SAVE_FORMAL') {
    return {
      committed: false,
      marker: 'TEST_ONLY_ISOLATED_COMMIT',
      reason: 'DO_NOT_SAVE'
    };
  }
  return executeFormalCommit(spec, pageDraft, options);
}

module.exports = {
  PROVIDER_ONLY_BLOCK,
  businessHash,
  evaluateDraftPreflight,
  executeFormalCommit,
  executeIsolatedLegacyCommit,
  prepareLegacyDraft,
  storageAudit,
  stripTestAiExecutionMetadata
};
