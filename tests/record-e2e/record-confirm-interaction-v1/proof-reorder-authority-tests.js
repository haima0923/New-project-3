#!/usr/bin/env node

const { isFormalReady } = require('../../../utils/business');
const parseSafety = require('../../../utils/parse-safety');
const { safeClone, stableHash } = require('../../../utils/record-state-diff');
const { BUSINESS_DATE } = require('./fixtures');
const { answerQuestion, submitOriginalText, tick } = require('./page-actions');
const { createPageHarness, stateCounts } = require('./runtime');

const MISSING_SECOND_QUANTITY = '王总下单：大号礼品盒100个，每个3元；小号礼品盒每个2元；8月15日交货。';
const TARGET_VALUE = '200';
const FIRST_ITEM_ALIASES = [
  'productName', 'spec', 'quantity', 'unit', 'unitPrice', 'priceUnit',
  'itemDeliveryDate', 'itemRemark'
];

function check(code, pass, detail = {}) {
  return { code, detail, pass: Boolean(pass) };
}

function proofCount(result) {
  return Array.isArray(result && result.user_manual_edits)
    ? result.user_manual_edits.length
    : 0;
}

function firstProof(result) {
  return (result && result.user_manual_edits || [])[0] || null;
}

function resolution(result) {
  return parseSafety.evaluateUserResolvedAiState(result);
}

function proofSemanticState(result) {
  const fields = safeClone(result && result.fields || {});
  const items = Array.isArray(fields.items) ? fields.items : [];
  const validKeys = items.map((item) => String(item && item.confirmationItemKey || '').trim());
  const uniqueKeys = new Set(validKeys);
  const itemKeysValid = validKeys.length === items.length
    && validKeys.every(Boolean)
    && uniqueKeys.size === validKeys.length;
  const first = items[0] || {};
  const aliasesValid = items.length <= 1 || FIRST_ITEM_ALIASES.every((field) => (
    String(fields[field] === undefined || fields[field] === null ? '' : fields[field])
      === String(first[field] === undefined || first[field] === null ? '' : first[field])
  ));
  if (items.length > 1) {
    FIRST_ITEM_ALIASES.forEach((field) => delete fields[field]);
  }
  fields.items = items.slice().sort((left, right) => (
    String(left.confirmationItemKey || '').localeCompare(String(right.confirmationItemKey || ''))
  ));
  const context = result && result.client_confirmation_context || {};
  const proofSemantics = (Array.isArray(result && result.user_manual_edits)
    ? result.user_manual_edits
    : []).map((proof) => ({
    field: String(proof && proof.field || ''),
    itemIdentityFingerprint: String(proof && proof.itemIdentityFingerprint || ''),
    itemKey: String(proof && proof.itemKey || ''),
    questionId: String(proof && proof.questionId || ''),
    riskIds: (proof && proof.riskIds || []).slice().sort(),
    source: String(proof && proof.source || ''),
    valueFingerprint: String(proof && proof.valueFingerprint || '')
  })).sort((left, right) => (
    `${left.itemKey}|${left.field}|${left.source}`.localeCompare(`${right.itemKey}|${right.field}|${right.source}`)
  ));
  const riskSemantics = parseSafety.collectUserResolvableAiRisks(result || {}, result && result.fields || {})
    .map((risk) => ({
      field: String(risk && risk.field || ''),
      itemField: String(risk && risk.itemField || ''),
      itemKey: String(risk && risk.itemKey || ''),
      resolvable: Boolean(risk && risk.resolvable),
      riskId: String(risk && risk.riskId || ''),
      type: String(risk && risk.type || '')
    }))
    .sort((left, right) => left.riskId.localeCompare(right.riskId));
  return {
    aiRevision: Number(result && result.ai_resolution_revision || 0),
    fields,
    aliasesValid,
    confirmationContext: {
      confirmationSessionId: String(context.confirmationSessionId || ''),
      originalTextFingerprint: String(context.originalTextFingerprint || '')
    },
    formalSaveBlocked: Boolean(result && result.formal_save_blocked),
    intent: String(result && result.intent || ''),
    itemKeysValid,
    mixedBusiness: Boolean(result && result.mixed_business),
    noRecord: Boolean(result && result.no_record),
    proofSemantics,
    relationReferences: safeClone(result && result.relation_references || null),
    requiresExistingRecord: Boolean(result && result.requires_existing_record),
    riskSemantics
  };
}

function expectedProofSemanticFingerprint(result) {
  return stableHash(proofSemanticState(result), 'proof-reorder-semantic-context-v1');
}

function fullDraftFingerprint(result) {
  return stableHash(result, 'proof-reorder-full-draft-v1');
}

function reprojectFirstItemAliases(fields) {
  const next = safeClone(fields || {});
  const first = Array.isArray(next.items) ? next.items[0] : null;
  if (first && next.items.length > 1) {
    FIRST_ITEM_ALIASES.forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(first, field)) next[field] = first[field];
      else delete next[field];
    });
  }
  return next;
}

function reprojectRiskLocations(result) {
  const next = safeClone(result);
  const items = next.fields && Array.isArray(next.fields.items) ? next.fields.items : [];
  next.field_conflicts = (next.field_conflicts || []).map((conflict) => {
    if (!conflict || conflict.field !== 'items' || !conflict.itemKey) return conflict;
    const itemIndex = items.findIndex((item) => (
      String(item.confirmationItemKey || '') === String(conflict.itemKey || '')
    ));
    if (itemIndex < 0) return conflict;
    const itemField = String(conflict.itemField || '').trim();
    return Object.assign({}, conflict, {
      fieldPath: itemField && itemField !== 'identity'
        ? `items[${itemIndex}].${itemField}`
        : conflict.fieldPath,
      itemIndex
    });
  });
  return next;
}

function pureReorder(result) {
  const next = safeClone(result);
  const before = next.fields && Array.isArray(next.fields.items) ? next.fields.items : [];
  next.fields = reprojectFirstItemAliases(Object.assign({}, next.fields, {
    items: before.slice().reverse()
  }));
  return reprojectRiskLocations(next);
}

function review(result) {
  return parseSafety.applyFinalParseSafety(safeClone(result), {
    businessDate: BUSINESS_DATE
  });
}

function targetIndex(result, itemKey) {
  const items = result && result.fields && Array.isArray(result.fields.items)
    ? result.fields.items
    : [];
  return items.findIndex((item) => String(item.confirmationItemKey || '') === String(itemKey || ''));
}

function summarize(result, state) {
  const proof = firstProof(result) || {};
  return {
    aiRevision: Number(result && result.ai_resolution_revision || 0),
    draftFingerprint: proof.draftFingerprint || '',
    field: proof.field || '',
    fieldPath: proof.fieldPath || '',
    formalReady: isFormalReady(result, state),
    fullDraftFingerprint: fullDraftFingerprint(result),
    itemKey: proof.itemKey || '',
    proofCount: proofCount(result),
    resolution: resolution(result),
    semanticFingerprint: expectedProofSemanticFingerprint(result),
    source: proof.source || '',
    stateFingerprint: proof.stateFingerprint || '',
    valueFingerprint: proof.valueFingerprint || ''
  };
}

async function authorizedDraft(source, caseId) {
  const harness = createPageHarness({
    caseId,
    networkMode: 'DEFERRED',
    text: MISSING_SECOND_QUANTITY
  });
  const beforeState = safeClone(harness.readState());
  try {
    await submitOriginalText(harness.page, MISSING_SECOND_QUANTITY);
    const question = safeClone(harness.page.data.activeQuestion);
    if (!question || !question.target || question.target.field !== 'quantity') {
      const error = new Error(`${caseId}: real page did not create the expected quantity question`);
      error.code = 'PROOF_REORDER_QUESTION_MISSING';
      throw error;
    }
    if (source === 'USER_PAGE_EDIT') {
      harness.page.updateItemField({
        currentTarget: {
          dataset: {
            field: 'quantity',
            itemKey: question.target.itemKey
          }
        },
        detail: { value: TARGET_VALUE }
      });
      await tick();
    } else {
      const answered = await answerQuestion(harness.page, TARGET_VALUE);
      if (!answered.supported) {
        const error = new Error(`${caseId}: real assistant answer handler was unavailable`);
        error.code = 'PROOF_REORDER_ANSWER_UNSUPPORTED';
        throw error;
      }
    }
    const draft = safeClone(harness.page.data.parseResult);
    const reviewed = review(draft);
    const proof = firstProof(reviewed);
    if (!proof
      || proof.source !== source
      || proof.itemKey !== question.target.itemKey
      || proof.field !== 'quantity'
      || resolution(reviewed).status !== 'MANUAL_RESOLUTION_COMPLETE') {
      const error = new Error(`${caseId}: real page action did not create an accepted ${source} proof`);
      error.code = 'PROOF_REORDER_POSITIVE_CONTROL_INVALID';
      throw error;
    }
    return {
      beforeState,
      dispose: () => harness.dispose(),
      draft: reviewed,
      networkRequests: harness.network.aiEvents().length,
      page: harness.page,
      question,
      state: safeClone(harness.readState()),
      storageMutation: stableHash(beforeState, `${caseId}-state`)
        !== stableHash(harness.readState(), `${caseId}-state`)
    };
  } catch (error) {
    harness.dispose();
    throw error;
  }
}

function positiveControlChecks(prefix, fixture) {
  const proof = firstProof(fixture.draft) || {};
  return [
    check(`${prefix}_REAL_PAGE_PROOF_CREATED`, proofCount(fixture.draft) === 1, proof),
    check(`${prefix}_REAL_PAGE_SOURCE`, Boolean(proof.source), proof),
    check(`${prefix}_REAL_PAGE_ITEM_BOUND`, Boolean(proof.itemKey) && proof.field === 'quantity', proof),
    check(`${prefix}_REAL_PAGE_VALUE_APPLIED`, (
      fixture.draft.fields.items[targetIndex(fixture.draft, proof.itemKey)] || {}
    ).quantity === TARGET_VALUE, proof),
    check(`${prefix}_PRE_REORDER_COMPLETE`, resolution(fixture.draft).status === 'MANUAL_RESOLUTION_COMPLETE', resolution(fixture.draft)),
    check(`${prefix}_AI_REQUEST_ZERO`, fixture.networkRequests === 0, { requests: fixture.networkRequests }),
    check(`${prefix}_BUSINESS_STORAGE_MUTATION_ZERO`, fixture.storageMutation === false, {
      before: stateCounts(fixture.beforeState),
      after: stateCounts(fixture.state)
    })
  ];
}

async function proofReorder001() {
  const fixture = await authorizedDraft('USER_PAGE_EDIT', 'PROOF-REORDER-001');
  try {
    const before = summarize(fixture.draft, fixture.state);
    const reorderedRaw = pureReorder(fixture.draft);
    const beforeOrder = fixture.draft.fields.items.map((item) => item.confirmationItemKey);
    const afterOrder = reorderedRaw.fields.items.map((item) => item.confirmationItemKey);
    const after = review(reorderedRaw);
    const afterSummary = summarize(after, fixture.state);
    const requestedSemanticFingerprint = expectedProofSemanticFingerprint(reorderedRaw);
    const reviewedOrder = after.fields.items.map((item) => item.confirmationItemKey);
    const proof = firstProof(after) || {};
    const target = after.fields.items[targetIndex(after, before.itemKey)] || {};
    const evidence = {
      after: afterSummary,
      afterOrder,
      before,
      beforeOrder,
      requestedSemanticFingerprint,
      reviewedOrder
    };
    return {
      checks: positiveControlChecks('PROOF_REORDER_001', fixture).concat([
        check('PROOF_REORDER_001_DISPLAY_ORDER_CHANGED', afterOrder.join('|') === beforeOrder.slice().reverse().join('|'), evidence),
        check('PROOF_REORDER_001_REVIEW_PRESERVES_REAL_ITEM_ORDER', (
          reviewedOrder.join('|') === afterOrder.join('|')
            && JSON.stringify(after.fields.items) === JSON.stringify(reorderedRaw.fields.items)
        ), evidence),
        check('PROOF_REORDER_001_EXPECTED_SEMANTIC_FINGERPRINT_STABLE', before.semanticFingerprint === requestedSemanticFingerprint, evidence),
        check('PROOF_REORDER_001_PAGE_EDIT_PROOF_SURVIVES', afterSummary.proofCount === 1, evidence),
        check('PROOF_REORDER_001_TARGET_KEY_AND_VALUE_STABLE', proof.itemKey === before.itemKey && target.quantity === TARGET_VALUE, evidence),
        check('PROOF_REORDER_001_RESOLUTION_STABLE', afterSummary.resolution.status === before.resolution.status, evidence),
        check('PROOF_REORDER_001_PRE_REORDER_FORMAL_READY', before.formalReady === true, evidence),
        check('PROOF_REORDER_001_POST_REORDER_FORMAL_READY', afterSummary.formalReady === true, evidence)
      ]),
      evidence
    };
  } finally {
    fixture.dispose();
  }
}

async function proofReorder002() {
  const fixture = await authorizedDraft('USER_ASSISTANT_ANSWER', 'PROOF-REORDER-002');
  try {
    const before = summarize(fixture.draft, fixture.state);
    const reorderedRaw = pureReorder(fixture.draft);
    const after = review(reorderedRaw);
    const afterSummary = summarize(after, fixture.state);
    const requestedSemanticFingerprint = expectedProofSemanticFingerprint(reorderedRaw);
    const proof = firstProof(after) || {};
    const itemIndex = targetIndex(after, before.itemKey);
    const reviewedOrder = after.fields.items.map((item) => item.confirmationItemKey);
    const requestedOrder = reorderedRaw.fields.items.map((item) => item.confirmationItemKey);
    const evidence = {
      after: afterSummary,
      before,
      currentTargetIndex: itemIndex,
      requestedOrder,
      requestedSemanticFingerprint,
      reviewedOrder
    };
    return {
      checks: positiveControlChecks('PROOF_REORDER_002', fixture).concat([
        check('PROOF_REORDER_002_EXPECTED_SEMANTIC_FINGERPRINT_STABLE', before.semanticFingerprint === requestedSemanticFingerprint, evidence),
        check('PROOF_REORDER_002_REVIEW_PRESERVES_REAL_ITEM_ORDER', (
          reviewedOrder.join('|') === requestedOrder.join('|')
            && JSON.stringify(after.fields.items) === JSON.stringify(reorderedRaw.fields.items)
        ), evidence),
        check('PROOF_REORDER_002_ASSISTANT_PROOF_SURVIVES', afterSummary.proofCount === 1, evidence),
        check('PROOF_REORDER_002_KEY_FIELD_AUTHORITY_STABLE', proof.itemKey === before.itemKey && proof.field === 'quantity', evidence),
        check('PROOF_REORDER_002_FIELDPATH_REPROJECTED', proof.fieldPath === `items[${itemIndex}].quantity`, evidence),
        check('PROOF_REORDER_002_RESOLUTION_STABLE', afterSummary.resolution.status === before.resolution.status, evidence),
        check('PROOF_REORDER_002_FORMAL_ELIGIBILITY_STABLE', afterSummary.formalReady === before.formalReady, evidence)
      ]),
      evidence
    };
  } finally {
    fixture.dispose();
  }
}

async function proofReorder003() {
  const fixture = await authorizedDraft('USER_ASSISTANT_ANSWER', 'PROOF-REORDER-003');
  try {
    const proof = firstProof(fixture.draft);
    const changed = pureReorder(fixture.draft);
    const index = targetIndex(changed, proof.itemKey);
    changed.fields.items[index].quantity = '201';
    const reviewed = review(changed);
    const evidence = {
      changedValue: changed.fields.items[index].quantity,
      outcome: summarize(reviewed, fixture.state),
      targetKey: proof.itemKey
    };
    return {
      checks: positiveControlChecks('PROOF_REORDER_003', fixture).concat([
        check('PROOF_REORDER_003_VALUE_CHANGE_INVALIDATES_PROOF', proofCount(reviewed) === 0, evidence),
        check('PROOF_REORDER_003_NOT_MANUAL_COMPLETE', resolution(reviewed).status !== 'MANUAL_RESOLUTION_COMPLETE', evidence),
        check('PROOF_REORDER_003_FORMAL_BLOCKED', isFormalReady(reviewed, fixture.state) === false, evidence)
      ]),
      evidence
    };
  } finally {
    fixture.dispose();
  }
}

async function proofReorder004() {
  const fixture = await authorizedDraft('USER_ASSISTANT_ANSWER', 'PROOF-REORDER-004');
  try {
    const beforeProof = firstProof(fixture.draft);
    const reordered = review(pureReorder(fixture.draft));
    const proof = firstProof(reordered) || {};
    const targetIndexAfter = targetIndex(reordered, beforeProof.itemKey);
    const otherIndex = targetIndexAfter === 0 ? 1 : 0;
    const target = reordered.fields.items[targetIndexAfter] || {};
    const other = reordered.fields.items[otherIndex] || {};
    const evidence = {
      other: { itemKey: other.confirmationItemKey, productName: other.productName, spec: other.spec },
      outcome: summarize(reordered, fixture.state),
      target: { itemKey: target.confirmationItemKey, productName: target.productName, spec: target.spec }
    };
    return {
      checks: positiveControlChecks('PROOF_REORDER_004', fixture).concat([
        check('PROOF_REORDER_004_SAME_NAME_DIFFERENT_SPEC_CONTROL', target.productName === other.productName && target.spec !== other.spec, evidence),
        check('PROOF_REORDER_004_TARGET_PROOF_SURVIVES', proofCount(reordered) === 1, evidence),
        check('PROOF_REORDER_004_PROOF_STAYS_ON_SMALL_SPEC_KEY', proof.itemKey === beforeProof.itemKey && target.spec === '小号', evidence),
        check('PROOF_REORDER_004_PROOF_NOT_CROSSED_TO_OTHER_ITEM', proof.itemKey !== other.confirmationItemKey, evidence)
      ]),
      evidence
    };
  } finally {
    fixture.dispose();
  }
}

async function proofReorder005() {
  const fixture = await authorizedDraft('USER_ASSISTANT_ANSWER', 'PROOF-REORDER-005');
  try {
    const baseProof = firstProof(fixture.draft);
    const variants = {
      aiRevision: (draft) => { draft.ai_resolution_revision = Number(draft.ai_resolution_revision || 0) + 1; },
      itemKey: (draft) => {
        const index = targetIndex(draft, baseProof.itemKey);
        draft.fields.items[index].confirmationItemKey = 'replacement-item-key';
      },
      originalText: (draft) => { draft.client_confirmation_context.originalTextFingerprint = 'changed-original-fingerprint'; },
      session: (draft) => { draft.client_confirmation_context.confirmationSessionId = 'changed-confirmation-session'; }
    };
    const outcomes = Object.fromEntries(Object.entries(variants).map(([name, mutate]) => {
      const candidate = pureReorder(fixture.draft);
      mutate(candidate);
      const reviewed = review(candidate);
      return [name, summarize(reviewed, fixture.state)];
    }));
    const checks = positiveControlChecks('PROOF_REORDER_005', fixture);
    Object.entries(outcomes).forEach(([name, outcome]) => {
      checks.push(
        check(`PROOF_REORDER_005_${name.toUpperCase()}_INVALIDATES_PROOF`, outcome.proofCount === 0, outcome),
        check(`PROOF_REORDER_005_${name.toUpperCase()}_NOT_COMPLETE`, outcome.resolution.status !== 'MANUAL_RESOLUTION_COMPLETE', outcome)
      );
    });
    return { checks, evidence: outcomes };
  } finally {
    fixture.dispose();
  }
}

async function proofReorder006() {
  const fixture = await authorizedDraft('USER_ASSISTANT_ANSWER', 'PROOF-REORDER-006');
  try {
    const baseProof = firstProof(fixture.draft);
    const candidate = pureReorder(fixture.draft);
    const index = targetIndex(candidate, baseProof.itemKey);
    candidate.field_conflicts = (candidate.field_conflicts || []).concat({
      code: 'POST_REORDER_QUANTITY_CONFLICT',
      field: 'items',
      fieldPath: `items[${index}].quantity`,
      itemField: 'quantity',
      itemIndex: index,
      itemKey: baseProof.itemKey,
      message: '重排后出现新的数量冲突。',
      values: ['200', '201']
    });
    const reviewed = review(candidate);
    const newRiskPresent = (reviewed.field_conflicts || []).some((risk) => (
      risk && risk.code === 'POST_REORDER_QUANTITY_CONFLICT'
    ));
    const evidence = {
      conflicts: reviewed.field_conflicts || [],
      outcome: summarize(reviewed, fixture.state)
    };
    return {
      checks: positiveControlChecks('PROOF_REORDER_006', fixture).concat([
        check('PROOF_REORDER_006_NEW_RISK_REMAINS', newRiskPresent, evidence),
        check('PROOF_REORDER_006_OLD_PROOF_CANNOT_SWALLOW_NEW_RISK', (
          resolution(reviewed).unresolvedRiskIds.length > 0
        ), evidence),
        check('PROOF_REORDER_006_NOT_MANUAL_COMPLETE', resolution(reviewed).status !== 'MANUAL_RESOLUTION_COMPLETE', evidence),
        check('PROOF_REORDER_006_FORMAL_BLOCKED', isFormalReady(reviewed, fixture.state) === false, evidence)
      ]),
      evidence
    };
  } finally {
    fixture.dispose();
  }
}

async function proofReorder007() {
  const fixture = await authorizedDraft('USER_PAGE_EDIT', 'PROOF-REORDER-007');
  try {
    const baseProof = firstProof(fixture.draft);
    const variants = {
      aliasMismatch: (draft) => {
        draft.fields.productName = '伪造的首项别名';
      },
      blank: (draft) => {
        const index = targetIndex(draft, baseProof.itemKey);
        draft.fields.items[index].confirmationItemKey = '';
      },
      duplicate: (draft) => {
        draft.fields.items.forEach((item) => { item.confirmationItemKey = baseProof.itemKey; });
      }
    };
    const outcomes = Object.fromEntries(Object.entries(variants).map(([name, mutate]) => {
      const candidate = pureReorder(fixture.draft);
      mutate(candidate);
      const reviewed = review(candidate);
      return [name, {
        itemKeys: reviewed.fields.items.map((item) => item.confirmationItemKey),
        summary: summarize(reviewed, fixture.state)
      }];
    }));
    const checks = positiveControlChecks('PROOF_REORDER_007', fixture);
    Object.entries(outcomes).forEach(([name, outcome]) => {
      checks.push(
        check(`PROOF_REORDER_007_${name.toUpperCase()}_FAILS_CLOSED`, outcome.summary.proofCount === 0, outcome),
        check(`PROOF_REORDER_007_${name.toUpperCase()}_NOT_COMPLETE`, outcome.summary.resolution.status !== 'MANUAL_RESOLUTION_COMPLETE', outcome),
        check(`PROOF_REORDER_007_${name.toUpperCase()}_FORMAL_BLOCKED`, outcome.summary.formalReady === false, outcome)
      );
    });
    return { checks, evidence: outcomes };
  } finally {
    fixture.dispose();
  }
}

function nextDraftContext(result) {
  const current = result.client_confirmation_context || {};
  const revision = Number(current.draftRevision || 0);
  return Object.assign({}, current, {
    draftRevision: String(Number.isFinite(revision) ? revision + 1 : 1)
  });
}

function reconcileReorderRevision(result, fields, nextContext) {
  const reconciled = parseSafety.reconcileTrustedUserManualEditState(result, fields, {
    action: 'REORDER_ITEMS',
    nextConfirmationContext: nextContext
  });
  return review(Object.assign({}, reconciled, {
    client_confirmation_context: safeClone(nextContext),
    fields: safeClone(fields)
  }));
}

async function proofReorder008() {
  const fixture = await authorizedDraft('USER_ASSISTANT_ANSWER', 'PROOF-REORDER-008');
  try {
    const baseProof = firstProof(fixture.draft);
    const pureCandidate = pureReorder(fixture.draft);
    const nextContext = nextDraftContext(fixture.draft);
    const pureRebased = reconcileReorderRevision(fixture.draft, pureCandidate.fields, nextContext);
    const changedFields = safeClone(pureCandidate.fields);
    changedFields.items[targetIndex({ fields: changedFields }, baseProof.itemKey)].quantity = '201';
    const changedRebased = reconcileReorderRevision(fixture.draft, changedFields, nextContext);
    const riskChangedSource = safeClone(fixture.draft);
    const riskIndex = targetIndex(riskChangedSource, baseProof.itemKey);
    riskChangedSource.field_conflicts = (riskChangedSource.field_conflicts || []).concat({
      code: 'REBASE_NEW_RISK',
      field: 'items',
      fieldPath: `items[${riskIndex}].quantity`,
      itemField: 'quantity',
      itemIndex: riskIndex,
      itemKey: baseProof.itemKey,
      message: 'revision rebase 时出现新风险。',
      values: ['200', '201']
    });
    const riskRebased = reconcileReorderRevision(riskChangedSource, pureCandidate.fields, nextContext);
    const sessionContext = Object.assign({}, nextContext, {
      confirmationSessionId: 'changed-rebase-session'
    });
    const sessionRebased = reconcileReorderRevision(fixture.draft, pureCandidate.fields, sessionContext);
    const originalContext = Object.assign({}, nextContext, {
      originalTextFingerprint: 'changed-rebase-original-fingerprint'
    });
    const originalRebased = reconcileReorderRevision(fixture.draft, pureCandidate.fields, originalContext);
    const aiRevisionSource = safeClone(fixture.draft);
    aiRevisionSource.ai_resolution_revision = Number(aiRevisionSource.ai_resolution_revision || 0) + 1;
    const aiRevisionRebased = reconcileReorderRevision(aiRevisionSource, pureCandidate.fields, nextContext);
    const pureProof = firstProof(pureRebased) || {};
    const evidence = {
      changedValue: summarize(changedRebased, fixture.state),
      fromRevision: String((fixture.draft.client_confirmation_context || {}).draftRevision || ''),
      aiRevisionChanged: summarize(aiRevisionRebased, fixture.state),
      originalChanged: summarize(originalRebased, fixture.state),
      pure: summarize(pureRebased, fixture.state),
      riskChanged: summarize(riskRebased, fixture.state),
      sessionChanged: summarize(sessionRebased, fixture.state),
      toRevision: nextContext.draftRevision
    };
    return {
      checks: positiveControlChecks('PROOF_REORDER_008', fixture).concat([
        check('PROOF_REORDER_008_REVISION_ADVANCED', evidence.fromRevision !== evidence.toRevision, evidence),
        check('PROOF_REORDER_008_PURE_REORDER_REBASED', evidence.pure.proofCount === 1, evidence),
        check('PROOF_REORDER_008_REBASED_TO_NEW_REVISION', pureProof.draftRevision === nextContext.draftRevision, evidence),
        check('PROOF_REORDER_008_REBASED_FIELDPATH_CURRENT', pureProof.fieldPath === `items[${targetIndex(pureRebased, baseProof.itemKey)}].quantity`, evidence),
        check('PROOF_REORDER_008_VALUE_CHANGE_NOT_REBASED', evidence.changedValue.proofCount === 0, evidence),
        check('PROOF_REORDER_008_RISK_CHANGE_NOT_REBASED', evidence.riskChanged.proofCount === 0, evidence),
        check('PROOF_REORDER_008_SESSION_CHANGE_NOT_REBASED', evidence.sessionChanged.proofCount === 0, evidence),
        check('PROOF_REORDER_008_ORIGINAL_CHANGE_NOT_REBASED', evidence.originalChanged.proofCount === 0, evidence),
        check('PROOF_REORDER_008_AI_REVISION_CHANGE_NOT_REBASED', evidence.aiRevisionChanged.proofCount === 0, evidence)
      ]),
      evidence
    };
  } finally {
    fixture.dispose();
  }
}

const CASES = [
  ['PROOF-REORDER-001', proofReorder001],
  ['PROOF-REORDER-002', proofReorder002],
  ['PROOF-REORDER-003', proofReorder003],
  ['PROOF-REORDER-004', proofReorder004],
  ['PROOF-REORDER-005', proofReorder005],
  ['PROOF-REORDER-006', proofReorder006],
  ['PROOF-REORDER-007', proofReorder007],
  ['PROOF-REORDER-008', proofReorder008]
];

async function runRound(round) {
  const results = [];
  for (const [id, execute] of CASES) {
    try {
      const outcome = await execute();
      const firstFailure = outcome.checks.find((entry) => !entry.pass) || null;
      results.push({
        checks: outcome.checks,
        evidence: outcome.evidence,
        firstFailure,
        id,
        status: firstFailure ? 'CASE_FAIL' : 'PASS'
      });
    } catch (error) {
      results.push({
        error: { code: error.code || 'RUNNER_ERROR', message: error.message },
        firstFailure: null,
        id,
        status: 'RUNNER_ERROR'
      });
    }
  }
  return { results, round };
}

function resultFingerprint(result) {
  return stableHash({
    checks: (result.checks || []).map((entry) => ({ code: entry.code, pass: entry.pass })),
    error: result.error || null,
    id: result.id,
    status: result.status
  }, 'proof-reorder-authority-suite-v1');
}

async function runSuite(repeat = 2) {
  const rounds = [];
  for (let round = 1; round <= Math.max(2, Number(repeat || 2)); round += 1) {
    rounds.push(await runRound(round));
  }
  const baseline = new Map(rounds[0].results.map((result) => [result.id, resultFingerprint(result)]));
  const mismatches = rounds.slice(1).flatMap((round) => round.results
    .filter((result) => baseline.get(result.id) !== resultFingerprint(result))
    .map((result) => ({ id: result.id, round: round.round })));
  const runnerErrors = rounds.flatMap((round) => round.results)
    .filter((result) => result.status === 'RUNNER_ERROR');
  const failures = rounds[0].results.filter((result) => result.status === 'CASE_FAIL');
  return {
    contractGate: runnerErrors.length || mismatches.length
      ? 'HARNESS_FAILURE'
      : (failures.length ? 'EXPECTED_RED' : 'PASS'),
    determinism: mismatches.length ? 'UNSTABLE' : 'STABLE',
    results: rounds[0].results,
    rounds: rounds.length,
    runnerErrorCount: runnerErrors.length
  };
}

async function main() {
  const repeatIndex = process.argv.indexOf('--repeat');
  const report = await runSuite(repeatIndex >= 0 ? process.argv[repeatIndex + 1] : 2);
  console.log(`CONTRACT_GATE=${report.contractGate}`);
  console.log(`ROUNDS=${report.rounds}`);
  console.log(`DETERMINISM=${report.determinism}`);
  console.log(`RUNNER_ERROR=${report.runnerErrorCount}`);
  report.results.forEach((result) => {
    console.log(`${result.id}\t${result.status}\tFIRST=${result.firstFailure ? result.firstFailure.code : '-'}`);
  });
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.contractGate === 'HARNESS_FAILURE'
    ? 2
    : (report.contractGate === 'EXPECTED_RED' ? 1 : 0);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`RUNNER_FATAL=${error.code || 'RUNNER_FATAL'} ${error.message}`);
    process.exitCode = 2;
  });
}

module.exports = { CASES, runSuite };
