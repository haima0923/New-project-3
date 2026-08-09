#!/usr/bin/env node

const { isFormalReady } = require('../../../utils/business');
const { parseChineseDate, parseChineseDateDetail } = require('../../../utils/date');
const { safeClone, stableHash } = require('../../../utils/record-state-diff');
const { BUSINESS_DATE } = require('./fixtures');
const { submitOriginalText, tick } = require('./page-actions');
const { createPageHarness, diffCounts, stateCounts } = require('./runtime');

const DATE_QUESTION_TEXT = '王总订水杯100个，5元一个。';
const NUMBER_QUESTION_TEXT = '王总订水杯，5元一个，8月15日交货。';
const UNIT_PRICE_QUESTION_TEXT = '王总订水杯100个，8月15日交货。';
const AMOUNT_QUESTION_TEXT = '王总订水杯100个，每个5元，总价600元，8月15日交货。';
const TRUSTED_SOURCE_PATTERN = /(?:^|[_:\-\s])(?:USER|MANUAL)(?:$|[_:\-\s])/i;

function check(code, pass, detail = {}) {
  return { code, detail, pass: Boolean(pass) };
}

function failTestData(message) {
  const error = new Error(message);
  error.code = 'TEST_DATA_ERROR';
  throw error;
}

function questionType(question = {}) {
  return String(question.questionType || question.answerType || '').trim().toUpperCase();
}

function routeName(result = {}) {
  const route = result.parse_route || {};
  return String(route.client_route || route.semantic_decision || route.decision || '').toUpperCase();
}

function proofSummary(result = {}) {
  return (Array.isArray(result.user_manual_edits) ? result.user_manual_edits : []).map((proof) => ({
    confirmationSessionId: proof.confirmationSessionId || '',
    draftRevision: proof.draftRevision || '',
    field: proof.field || '',
    fieldPath: proof.fieldPath || '',
    itemKey: proof.itemKey || '',
    originalTextFingerprint: proof.originalTextFingerprint || '',
    questionId: proof.questionId || '',
    riskIds: safeClone(proof.riskIds || []),
    schemaVersion: proof.schemaVersion || '',
    signaturePresent: Boolean(proof.signature),
    source: proof.source || ''
  }));
}

function manualSummary(result = {}) {
  const sources = result.field_sources || {};
  return {
    manualFields: safeClone(result.manual_fields || result.manualFields || []),
    manualItemFields: safeClone(result.manual_item_fields || result.manualItemFields || []),
    proofs: proofSummary(result),
    trustedFieldSources: Object.entries(sources)
      .filter(([, source]) => TRUSTED_SOURCE_PATTERN.test(String(source || '')))
      .map(([field, source]) => ({ field, source }))
  };
}

function manualProvenanceIsEmpty(manual = {}) {
  return (manual.manualFields || []).length === 0
    && (manual.manualItemFields || []).length === 0
    && (manual.proofs || []).length === 0
    && (manual.trustedFieldSources || []).length === 0;
}

function semanticResultFingerprint(result = {}) {
  return stableHash({
    aiBusinessResultValid: result.ai_business_result_valid,
    businessResultValid: result.business_result_valid,
    fieldConflicts: result.field_conflicts || [],
    fields: result.fields || {},
    finalParseSafety: result.final_parse_safety || {},
    lowConfidenceFields: result.low_confidence_fields || [],
    manual: manualSummary(result),
    missingFields: result.missing_fields || [],
    parseRoute: result.parse_route || {},
    userResolution: result.user_resolution || {}
  }, 'question-answer-type-semantic-result-v1');
}

function businessCalls(harness) {
  return safeClone(harness.driver.evidence.productionBusinessCalls || {});
}

function storageCalls(harness) {
  return safeClone(harness.driver.evidence.productionStorageCalls || {});
}

function callsAreZero(calls = {}) {
  return Object.values(calls).every((value) => Number(value || 0) === 0);
}

function deltasAreZero(delta = {}) {
  return Object.values(delta).every((value) => Number(value || 0) === 0);
}

function currentQuestion(page) {
  return safeClone(page.data.activeQuestion || null);
}

function requireQuestion(page, expectedType, expectedField, label) {
  const question = currentQuestion(page);
  if (!question) failTestData(`${label}: production did not create an activeQuestion`);
  if (questionType(question) !== expectedType) {
    failTestData(`${label}: expected ${expectedType}, got ${questionType(question) || 'EMPTY'}`);
  }
  const target = question.target || {};
  if (target.field !== expectedField) {
    failTestData(`${label}: expected target ${expectedField}, got ${target.field || 'EMPTY'}`);
  }
  if (!question.questionId || !question.draftRevision || !question.originalTextFingerprint) {
    failTestData(`${label}: production question identity is incomplete`);
  }
  return question;
}

function questionDataset(question, overrides = {}) {
  const target = question.target || {};
  return Object.assign({
    field: target.field || '',
    fieldPath: target.fieldPath || '',
    itemKey: target.itemKey || '',
    originalTextFingerprint: question.originalTextFingerprint || '',
    questionId: question.questionId || '',
    revision: question.draftRevision || ''
  }, overrides);
}

function submitSurfaceAnswer(page, question, value, datasetOverrides = {}) {
  if (typeof page.updateAssistantAnswer !== 'function'
    || typeof page.submitAssistantAnswer !== 'function') {
    failTestData('production Surface answer actions are missing');
  }
  page.updateAssistantAnswer({ detail: { value: String(value) } });
  return page.submitAssistantAnswer({
    currentTarget: {
      dataset: questionDataset(question, datasetOverrides)
    }
  });
}

function getTargetValue(fields = {}, question = {}) {
  const target = question.target || {};
  if (!target.itemKey) return fields[target.field];
  const matches = (fields.items || []).filter((item) => (
    String(item && item.confirmationItemKey || '') === String(target.itemKey)
  ));
  return matches.length === 1 ? matches[0][target.field] : undefined;
}

function snapshot(harness, question) {
  const page = harness.page;
  const result = safeClone(page.data.parseResult || {});
  const state = safeClone(harness.readState());
  const active = currentQuestion(page);
  return {
    activeQuestion: active ? {
      confirmationSessionId: active.confirmationSessionId || '',
      draftRevision: active.draftRevision || '',
      field: (active.target || {}).field || '',
      fieldPath: (active.target || {}).fieldPath || '',
      itemKey: (active.target || {}).itemKey || '',
      originalTextFingerprint: active.originalTextFingerprint || '',
      questionId: active.questionId || '',
      riskIds: safeClone(active.riskIds || []),
      status: active.status || '',
      type: questionType(active)
    } : null,
    aiRequests: harness.network.aiEvents().length,
    assistantQuestionState: String(page.data.assistantQuestionState || ''),
    businessCalls: businessCalls(harness),
    clientConfirmationContext: safeClone(result.client_confirmation_context || {}),
    currentRequestedRoute: String(page.currentRequestedRoute || ''),
    disableFormalSave: page.data.disableFormalSave === true,
    draftRevision: String(page.draftRevision || ''),
    fields: safeClone(result.fields || {}),
    finalSafetyFingerprint: stableHash({
      finalParseSafety: result.final_parse_safety || {},
      userResolution: result.user_resolution || {}
    }, 'question-answer-type-final-safety-v1'),
    formalReady: isFormalReady(result, state),
    manual: manualSummary(result),
    originalText: String(result.original_text || ''),
    preflightFingerprint: String(page.data.preflightFingerprint || ''),
    route: routeName(result),
    semanticResultFingerprint: semanticResultFingerprint(result),
    stateCounts: stateCounts(state),
    stateFingerprint: stableHash(state, 'question-answer-type-state-v1'),
    storageCalls: storageCalls(harness),
    targetValue: question ? getTargetValue(result.fields || {}, question) : undefined,
    userResolution: safeClone(result.user_resolution || {})
  };
}

function responseSummary(response) {
  return {
    accepted: Boolean(response && response.accepted),
    code: String(response && response.code || '')
  };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameStringSet(left, right) {
  const normalize = (values) => (values || []).map(String).sort();
  return sameJson(normalize(left), normalize(right));
}

function trustedProofMatchesQuestion(proof = {}, question = {}) {
  const target = question.target || {};
  return proof.schemaVersion === 'USER_MANUAL_EDIT_V1'
    && proof.source === 'USER_ASSISTANT_ANSWER'
    && proof.signaturePresent === true
    && proof.questionId === question.questionId
    && proof.field === target.field
    && proof.fieldPath === target.fieldPath
    && proof.itemKey === (target.itemKey || '')
    && proof.confirmationSessionId === question.confirmationSessionId
    && proof.draftRevision === question.draftRevision
    && proof.originalTextFingerprint === question.originalTextFingerprint
    && sameStringSet(proof.riskIds, question.riskIds || []);
}

function resolutionAcceptsQuestion(after = {}, before = {}, question = {}) {
  const afterResolution = after.userResolution || {};
  const beforeResolution = before.userResolution || {};
  const beforeCount = Number(beforeResolution.trustedEditCount || 0);
  const resolved = new Set(afterResolution.resolvedRiskIds || []);
  return Number(afterResolution.trustedEditCount || 0) === beforeCount + 1
    && (question.riskIds || []).every((riskId) => resolved.has(riskId));
}

function invalidAnswerChecks(prefix, scenario) {
  const { after, before, originalText, question, response } = scenario;
  return [
    check(`${prefix}_ANSWER_REJECTED`, response.accepted === false, scenario.evidence),
    check(`${prefix}_PROOF_ZERO`, after.manual.proofs.length === 0, scenario.evidence),
    check(`${prefix}_PROOF_UNCHANGED`, sameJson(after.manual.proofs, before.manual.proofs), scenario.evidence),
    check(`${prefix}_MANUAL_PROVENANCE_ZERO`, manualProvenanceIsEmpty(after.manual), scenario.evidence),
    check(`${prefix}_MANUAL_PROVENANCE_UNCHANGED`, sameJson(after.manual, before.manual), scenario.evidence),
    check(`${prefix}_TARGET_VALUE_UNCHANGED`, String(after.targetValue || '') === String(before.targetValue || ''), scenario.evidence),
    check(`${prefix}_QUESTION_STAYS_OPEN`, Boolean(after.activeQuestion)
      && sameJson(after.activeQuestion, before.activeQuestion)
      && after.activeQuestion.questionId === question.questionId
      && after.activeQuestion.status === 'OPEN', scenario.evidence),
    check(`${prefix}_QUESTION_STATE_UNCHANGED`, after.assistantQuestionState === before.assistantQuestionState, scenario.evidence),
    check(`${prefix}_CONFIRMATION_CONTEXT_UNCHANGED`, sameJson(after.clientConfirmationContext, before.clientConfirmationContext), scenario.evidence),
    check(`${prefix}_REQUESTED_ROUTE_UNCHANGED`, after.currentRequestedRoute === before.currentRequestedRoute, scenario.evidence),
    check(`${prefix}_FORMAL_BLOCKED`, after.formalReady === false && after.disableFormalSave === true, scenario.evidence),
    check(`${prefix}_ROUTE_UNCHANGED`, after.route === before.route, scenario.evidence),
    check(`${prefix}_PREFLIGHT_UNCHANGED`, after.preflightFingerprint === before.preflightFingerprint, scenario.evidence),
    check(`${prefix}_BUSINESS_SEMANTICS_UNCHANGED`, after.semanticResultFingerprint === before.semanticResultFingerprint, scenario.evidence),
    check(`${prefix}_DRAFT_REVISION_UNCHANGED`, after.draftRevision === before.draftRevision, scenario.evidence),
    check(`${prefix}_ORIGINAL_TEXT_PRESERVED`, after.originalText === originalText, scenario.evidence),
    check(`${prefix}_AI_ZERO`, after.aiRequests === 0, scenario.evidence),
    check(`${prefix}_BUSINESS_ZERO`, callsAreZero(after.businessCalls), scenario.evidence),
    check(`${prefix}_STORAGE_ZERO`, callsAreZero(after.storageCalls), scenario.evidence),
    check(`${prefix}_STATE_UNCHANGED`, after.stateFingerprint === before.stateFingerprint
      && deltasAreZero(diffCounts(before.stateCounts, after.stateCounts)), scenario.evidence)
  ];
}

async function answerScenario(options) {
  const harness = createPageHarness({
    caseId: options.caseId,
    text: options.text
  });
  try {
    await submitOriginalText(harness.page, options.text);
    const question = requireQuestion(
      harness.page,
      options.expectedType,
      options.expectedField,
      options.caseId
    );
    const originalText = String((harness.page.data.parseResult || {}).original_text || '');
    if (typeof options.beforeAnswer === 'function') {
      options.beforeAnswer(harness.page, question);
    }
    const effectiveQuestion = currentQuestion(harness.page);
    const before = snapshot(harness, effectiveQuestion);
    const rawResponse = submitSurfaceAnswer(
      harness.page,
      effectiveQuestion,
      options.answer,
      options.datasetOverrides || {}
    );
    await tick();
    const after = snapshot(harness, effectiveQuestion);
    const response = responseSummary(rawResponse);
    return {
      after,
      before,
      evidence: {
        accepted: response.accepted,
        code: response.code,
        field: (effectiveQuestion.target || {}).field || '',
        fieldPath: (effectiveQuestion.target || {}).fieldPath || '',
        formalReadyAfter: after.formalReady,
        manualAfter: after.manual,
        nextQuestion: after.activeQuestion,
        preflightUnchanged: after.preflightFingerprint === before.preflightFingerprint,
        proofDelta: after.manual.proofs.length - before.manual.proofs.length,
        routeAfter: after.route,
        stateUnchanged: after.stateFingerprint === before.stateFingerprint,
        targetValueAfter: after.targetValue === undefined ? '' : String(after.targetValue),
        targetValueBefore: before.targetValue === undefined ? '' : String(before.targetValue),
        type: questionType(effectiveQuestion)
      },
      originalText,
      question: effectiveQuestion,
      response
    };
  } finally {
    harness.dispose();
  }
}

async function qtype001() {
  const values = ['乱写', '不知道', '随便', 'abc', '123abc', '--'];
  const outcomes = [];
  const checks = [];
  for (const [index, value] of values.entries()) {
    const scenario = await answerScenario({
      answer: value,
      caseId: `QTYPE-001-${index + 1}`,
      expectedField: 'dueDate',
      expectedType: 'DATE',
      text: DATE_QUESTION_TEXT
    });
    outcomes.push({ value, evidence: scenario.evidence });
    checks.push(...invalidAnswerChecks(`QTYPE_001_${index + 1}`, scenario));
  }
  return { checks, evidence: outcomes };
}

async function qtype002() {
  const values = [
    '2026-02-30',
    '2026-13-01',
    '2026-00-10',
    '2026-04-31',
    '2026-08-99',
    '2026/02/30',
    '2026年02月30日',
    '下周',
    '5号',
    '下午'
  ];
  const ambiguousValues = new Set(['下周', '5号', '下午']);
  const outcomes = [];
  const checks = [];
  for (const [index, value] of values.entries()) {
    const dateContract = parseChineseDateDetail(value, BUSINESS_DATE);
    const scenario = await answerScenario({
      answer: value,
      caseId: `QTYPE-002-${index + 1}`,
      expectedField: 'dueDate',
      expectedType: 'DATE',
      text: DATE_QUESTION_TEXT
    });
    outcomes.push({
      dateContract: {
        ambiguous: dateContract.ambiguous,
        date: dateContract.date,
        invalid: dateContract.invalid
      },
      evidence: scenario.evidence,
      value
    });
    checks.push(
      check(`QTYPE_002_${index + 1}_EXISTING_DATE_CONTRACT_REJECTS`, !dateContract.date, outcomes[index]),
      check(`QTYPE_002_${index + 1}_AMBIGUOUS_CLASSIFIED`, !ambiguousValues.has(value)
        || dateContract.ambiguous === true, outcomes[index]),
      ...invalidAnswerChecks(`QTYPE_002_${index + 1}`, scenario)
    );
  }
  return { checks, evidence: outcomes };
}

async function qtype003() {
  const variants = [
    { input: '2026-08-15', canonical: '2026-08-15', name: 'ABSOLUTE' },
    { input: '8月15日', canonical: '2026-08-15', name: 'NATURAL' }
  ];
  const checks = [];
  const evidence = [];
  for (const variant of variants) {
    const scenario = await answerScenario({
      answer: variant.input,
      caseId: `QTYPE-003-${variant.name}`,
      expectedField: 'dueDate',
      expectedType: 'DATE',
      text: DATE_QUESTION_TEXT
    });
    const dateContractValue = parseChineseDate(variant.input, BUSINESS_DATE);
    const detail = Object.assign({}, scenario.evidence, {
      canonical: variant.canonical,
      dateContractValue,
      input: variant.input
    });
    evidence.push(detail);
    const proof = scenario.after.manual.proofs[0] || {};
    checks.push(
      check(`QTYPE_003_${variant.name}_DATE_CONTRACT_CANONICAL`, dateContractValue === variant.canonical, detail),
      check(`QTYPE_003_${variant.name}_ANSWER_ACCEPTED`, scenario.response.accepted === true, detail),
      check(`QTYPE_003_${variant.name}_CANONICAL_ADOPTED`, String(scenario.after.targetValue || '') === variant.canonical, detail),
      check(`QTYPE_003_${variant.name}_PROOF_CREATED`, scenario.after.manual.proofs.length === 1, detail),
      check(`QTYPE_003_${variant.name}_PROOF_TRUSTED_BINDING`, trustedProofMatchesQuestion(proof, scenario.question), detail),
      check(`QTYPE_003_${variant.name}_RESOLUTION_RISK_BOUND`, resolutionAcceptsQuestion(scenario.after, scenario.before, scenario.question), detail),
      check(`QTYPE_003_${variant.name}_QUESTION_RESOLVED`, scenario.after.activeQuestion === null, detail),
      check(`QTYPE_003_${variant.name}_FINAL_SAFETY_RERUN`, scenario.after.finalSafetyFingerprint !== scenario.before.finalSafetyFingerprint, detail),
      check(`QTYPE_003_${variant.name}_PREFLIGHT_RERUN`, scenario.after.preflightFingerprint !== scenario.before.preflightFingerprint, detail),
      check(`QTYPE_003_${variant.name}_FORMAL_READY`, scenario.after.formalReady === true
        && scenario.after.disableFormalSave === false, detail),
      check(`QTYPE_003_${variant.name}_NO_AUTO_SAVE`, callsAreZero(scenario.after.businessCalls)
        && callsAreZero(scenario.after.storageCalls), detail),
      check(`QTYPE_003_${variant.name}_ORIGINAL_TEXT_PRESERVED`, scenario.after.originalText === DATE_QUESTION_TEXT, detail)
    );
  }
  return { checks, evidence };
}

async function qtype004() {
  const values = ['abc', '乱写', '--', '1a', 'NaN', 'Infinity', '0x32', '1e3', '', '   '];
  const checks = [];
  const outcomes = [];
  for (const [index, value] of values.entries()) {
    const scenario = await answerScenario({
      answer: value,
      caseId: `QTYPE-004-${index + 1}`,
      expectedField: 'quantity',
      expectedType: 'NUMBER',
      text: NUMBER_QUESTION_TEXT
    });
    outcomes.push({ value, evidence: scenario.evidence });
    checks.push(...invalidAnswerChecks(`QTYPE_004_${index + 1}`, scenario));
  }
  return { checks, evidence: outcomes };
}

async function qtype005() {
  const values = ['0', '-1', '-0.01'];
  const checks = [];
  const outcomes = [];
  for (const [index, value] of values.entries()) {
    const scenario = await answerScenario({
      answer: value,
      caseId: `QTYPE-005-${index + 1}`,
      expectedField: 'quantity',
      expectedType: 'NUMBER',
      text: NUMBER_QUESTION_TEXT
    });
    outcomes.push({ value, evidence: scenario.evidence });
    checks.push(
      check(`QTYPE_005_${index + 1}_TARGET_IS_POSITIVE_QUANTITY`, (scenario.question.target || {}).field === 'quantity', scenario.evidence),
      ...invalidAnswerChecks(`QTYPE_005_${index + 1}`, scenario)
    );
  }
  return { checks, evidence: outcomes };
}

async function validNumberScenario(options) {
  const scenario = await answerScenario(options);
  const proofDelta = scenario.after.manual.proofs.length - scenario.before.manual.proofs.length;
  const proof = scenario.after.manual.proofs[scenario.after.manual.proofs.length - 1] || {};
  return {
    checks: [
      check(`${options.prefix}_ANSWER_ACCEPTED`, scenario.response.accepted === true, scenario.evidence),
      check(`${options.prefix}_VALUE_CANONICAL`, String(scenario.after.targetValue || '') === options.canonical, scenario.evidence),
      check(`${options.prefix}_ONE_PROOF_CREATED`, proofDelta === 1, scenario.evidence),
      check(`${options.prefix}_PROOF_TRUSTED_BINDING`, trustedProofMatchesQuestion(proof, scenario.question), scenario.evidence),
      check(`${options.prefix}_RESOLUTION_RISK_BOUND`, resolutionAcceptsQuestion(scenario.after, scenario.before, scenario.question), scenario.evidence),
      check(`${options.prefix}_OTHER_FIELD_NOT_RESOLVED`, !scenario.after.manual.proofs.some((entry) => (
        entry.questionId === proof.questionId && entry.field !== options.expectedField
      )), scenario.evidence),
      check(`${options.prefix}_FINAL_SAFETY_RERUN`, scenario.after.finalSafetyFingerprint !== scenario.before.finalSafetyFingerprint, scenario.evidence),
      check(`${options.prefix}_PREFLIGHT_RERUN`, scenario.after.preflightFingerprint !== scenario.before.preflightFingerprint, scenario.evidence),
      check(`${options.prefix}_NO_AUTO_SAVE`, callsAreZero(scenario.after.businessCalls)
        && callsAreZero(scenario.after.storageCalls), scenario.evidence),
      check(`${options.prefix}_FORMAL_READY_CONTRACT`, options.expectFormalReady !== true
        || (scenario.after.formalReady === true && scenario.after.disableFormalSave === false), scenario.evidence),
      check(`${options.prefix}_ORIGINAL_TEXT_PRESERVED`, scenario.after.originalText === options.text, scenario.evidence),
      check(`${options.prefix}_STATE_UNCHANGED`, scenario.after.stateFingerprint === scenario.before.stateFingerprint, scenario.evidence)
    ],
    evidence: scenario.evidence
  };
}

async function qtype006() {
  const quantity = await validNumberScenario({
    answer: '100',
    canonical: '100',
    caseId: 'QTYPE-006-QUANTITY',
    expectedField: 'quantity',
    expectedType: 'NUMBER',
    prefix: 'QTYPE_006_QUANTITY',
    text: NUMBER_QUESTION_TEXT
  });
  const unitPrice = await validNumberScenario({
    answer: '3.8',
    canonical: '3.8',
    caseId: 'QTYPE-006-UNIT-PRICE',
    expectedField: 'unitPrice',
    expectedType: 'NUMBER',
    prefix: 'QTYPE_006_UNIT_PRICE',
    text: UNIT_PRICE_QUESTION_TEXT
  });
  const isolatedAmount = await validNumberScenario({
    answer: '500',
    canonical: '500',
    caseId: 'QTYPE-006-ISOLATED-AMOUNT',
    expectFormalReady: true,
    expectedField: 'amount',
    expectedType: 'NUMBER',
    prefix: 'QTYPE_006_ISOLATED_AMOUNT',
    text: AMOUNT_QUESTION_TEXT
  });
  return {
    checks: quantity.checks.concat(unitPrice.checks, isolatedAmount.checks),
    evidence: {
      isolatedAmount: isolatedAmount.evidence,
      quantity: quantity.evidence,
      unitPrice: unitPrice.evidence
    }
  };
}

async function qtype007() {
  const variants = [
    {
      answer: '乱写',
      datasetOverrides: { answerType: 'TEXT', questionType: 'TEXT' },
      expectedField: 'dueDate',
      expectedType: 'DATE',
      name: 'DATE_TO_TEXT',
      text: DATE_QUESTION_TEXT
    },
    {
      answer: 'abc',
      datasetOverrides: { answerType: 'TEXT', questionType: 'TEXT' },
      expectedField: 'quantity',
      expectedType: 'NUMBER',
      name: 'NUMBER_TO_TEXT',
      text: NUMBER_QUESTION_TEXT
    }
  ];
  const checks = [];
  const evidence = [];
  for (const variant of variants) {
    const scenario = await answerScenario({
      answer: variant.answer,
      caseId: `QTYPE-007-${variant.name}`,
      datasetOverrides: variant.datasetOverrides,
      expectedField: variant.expectedField,
      expectedType: variant.expectedType,
      text: variant.text
    });
    evidence.push(Object.assign({}, scenario.evidence, {
      attemptedType: 'TEXT',
      trustedType: variant.expectedType
    }));
    checks.push(
      check(`QTYPE_007_${variant.name}_TRUSTED_TYPE_FROM_ACTIVE_QUESTION`, questionType(scenario.question) === variant.expectedType, evidence[evidence.length - 1]),
      ...invalidAnswerChecks(`QTYPE_007_${variant.name}`, scenario)
    );
  }
  return { checks, evidence };
}

async function qtype008() {
  const variants = [
    { name: 'ROOT_AMOUNT', overrides: { field: 'amount', fieldPath: 'amount', itemKey: '' } },
    { name: 'ITEM_UNIT_PRICE', overrides: { field: 'unitPrice', fieldPath: 'items[0].unitPrice', itemKey: 'forged-item' } }
  ];
  const checks = [];
  const evidence = [];
  for (const variant of variants) {
    const scenario = await answerScenario({
      answer: '2026-08-15',
      caseId: `QTYPE-008-${variant.name}`,
      datasetOverrides: variant.overrides,
      expectedField: 'dueDate',
      expectedType: 'DATE',
      text: DATE_QUESTION_TEXT
    });
    evidence.push(Object.assign({}, scenario.evidence, { attemptedTarget: variant.overrides }));
    checks.push(
      check(`QTYPE_008_${variant.name}_STALE_TARGET_REJECTED`, scenario.response.accepted === false
        && scenario.response.code === 'QUESTION_STALE', evidence[evidence.length - 1]),
      ...invalidAnswerChecks(`QTYPE_008_${variant.name}`, scenario)
    );
  }
  return { checks, evidence };
}

async function qtype009() {
  const variants = [
    {
      answer: '2026-08-15',
      expectedField: 'dueDate',
      expectedType: 'DATE',
      injectedType: 'UNKNOWN_TYPE',
      name: 'UNKNOWN',
      text: DATE_QUESTION_TEXT
    },
    {
      answer: '乱写',
      expectedField: 'dueDate',
      expectedType: 'DATE',
      injectedType: 'TEXT',
      name: 'DATE_TO_TEXT',
      text: DATE_QUESTION_TEXT
    },
    {
      answer: 'abc',
      expectedField: 'quantity',
      expectedType: 'NUMBER',
      injectedType: 'TEXT',
      name: 'NUMBER_TO_TEXT',
      text: NUMBER_QUESTION_TEXT
    }
  ];
  const checks = [];
  const evidence = [];
  for (const variant of variants) {
    const scenario = await answerScenario({
      answer: variant.answer,
      beforeAnswer(page, question) {
        const tampered = Object.assign({}, question, {
          answerType: variant.injectedType,
          questionType: variant.injectedType
        });
        // Test-only untrusted observation seam. The identity, target and risks
        // still come from production; no question or proof authority is minted.
        page.setData({
          activeQuestion: tampered,
          assistantQuestions: [tampered]
        });
      },
      caseId: `QTYPE-009-${variant.name}`,
      expectedField: variant.expectedField,
      expectedType: variant.expectedType,
      text: variant.text
    });
    const detail = Object.assign({}, scenario.evidence, {
      injectedType: variant.injectedType,
      observationSeam: 'TEST_ONLY_UNTRUSTED_QUESTION_TYPE_OVERRIDE',
      productionType: variant.expectedType
    });
    evidence.push(detail);
    checks.push(
      check(`QTYPE_009_${variant.name}_TYPE_OBSERVED`, questionType(scenario.question) === variant.injectedType, detail),
      ...invalidAnswerChecks(`QTYPE_009_${variant.name}`, scenario)
    );
  }
  return { checks, evidence };
}

async function recoveryScenario(options) {
  const harness = createPageHarness({ caseId: options.caseId, text: options.text });
  try {
    await submitOriginalText(harness.page, options.text);
    const firstQuestion = requireQuestion(
      harness.page,
      options.expectedType,
      options.expectedField,
      options.caseId
    );
    const initial = snapshot(harness, firstQuestion);
    const firstResponse = responseSummary(submitSurfaceAnswer(
      harness.page,
      firstQuestion,
      options.invalidAnswer
    ));
    await tick();
    const afterInvalid = snapshot(harness, firstQuestion);
    const retainedQuestion = currentQuestion(harness.page);
    let secondResponse = { accepted: false, code: 'SECOND_NOT_RUN' };
    if (retainedQuestion && retainedQuestion.questionId === firstQuestion.questionId) {
      secondResponse = responseSummary(submitSurfaceAnswer(
        harness.page,
        retainedQuestion,
        options.validAnswer
      ));
      await tick();
    }
    const afterValid = snapshot(harness, firstQuestion);
    const evidence = {
      afterInvalid: {
        accepted: firstResponse.accepted,
        manual: afterInvalid.manual,
        question: afterInvalid.activeQuestion,
        targetValue: String(afterInvalid.targetValue || '')
      },
      afterValid: {
        accepted: secondResponse.accepted,
        manual: afterValid.manual,
        question: afterValid.activeQuestion,
        targetValue: String(afterValid.targetValue || '')
      },
      initialTargetValue: String(initial.targetValue || ''),
      stateUnchanged: initial.stateFingerprint === afterValid.stateFingerprint
    };
    const firstInvalidChecks = invalidAnswerChecks(`${options.prefix}_FIRST`, {
      after: afterInvalid,
      before: initial,
      evidence,
      originalText: options.text,
      question: firstQuestion,
      response: firstResponse
    });
    return {
      checks: [
        ...firstInvalidChecks,
        check(`${options.prefix}_SECOND_ACCEPTED`, secondResponse.accepted === true, evidence),
        check(`${options.prefix}_SECOND_VALUE_CANONICAL`, String(afterValid.targetValue || '') === options.canonical, evidence),
        check(`${options.prefix}_SECOND_PROOF_ONE`, afterValid.manual.proofs.length === initial.manual.proofs.length + 1, evidence),
        check(`${options.prefix}_ORIGINAL_TEXT_PRESERVED`, afterValid.originalText === options.text, evidence),
        check(`${options.prefix}_NO_AUTO_SAVE`, callsAreZero(afterValid.businessCalls)
          && callsAreZero(afterValid.storageCalls), evidence),
        check(`${options.prefix}_STATE_UNCHANGED`, initial.stateFingerprint === afterValid.stateFingerprint, evidence)
      ],
      evidence
    };
  } finally {
    harness.dispose();
  }
}

async function qtype010() {
  const date = await recoveryScenario({
    canonical: '2026-08-15',
    caseId: 'QTYPE-010-DATE',
    expectedField: 'dueDate',
    expectedType: 'DATE',
    invalidAnswer: '乱写',
    prefix: 'QTYPE_010_DATE',
    text: DATE_QUESTION_TEXT,
    validAnswer: '8月15日'
  });
  const number = await recoveryScenario({
    canonical: '100',
    caseId: 'QTYPE-010-NUMBER',
    expectedField: 'quantity',
    expectedType: 'NUMBER',
    invalidAnswer: 'abc',
    prefix: 'QTYPE_010_NUMBER',
    text: NUMBER_QUESTION_TEXT,
    validAnswer: '100'
  });
  return {
    checks: date.checks.concat(number.checks),
    evidence: { date: date.evidence, number: number.evidence }
  };
}

const CASES = [
  ['QTYPE-001', qtype001],
  ['QTYPE-002', qtype002],
  ['QTYPE-003', qtype003],
  ['QTYPE-004', qtype004],
  ['QTYPE-005', qtype005],
  ['QTYPE-006', qtype006],
  ['QTYPE-007', qtype007],
  ['QTYPE-008', qtype008],
  ['QTYPE-009', qtype009],
  ['QTYPE-010', qtype010]
];

async function runRound(round) {
  const results = [];
  for (const [id, execute] of CASES) {
    try {
      const outcome = await execute();
      const firstFailure = (outcome.checks || []).find((entry) => !entry.pass) || null;
      results.push({
        checks: outcome.checks || [],
        evidence: outcome.evidence || {},
        firstFailure,
        id,
        status: firstFailure ? 'CASE_FAIL' : 'PASS'
      });
    } catch (error) {
      results.push({
        error: {
          code: error.code || 'RUNNER_ERROR',
          message: error.message
        },
        firstFailure: null,
        id,
        status: 'RUNNER_ERROR'
      });
    }
  }
  return { results, round };
}

function semanticFingerprint(result) {
  return stableHash({
    checks: (result.checks || []).map((entry) => ({ code: entry.code, pass: entry.pass })),
    error: result.error || null,
    evidence: result.evidence || null,
    id: result.id,
    status: result.status
  }, 'record-question-answer-type-trust-v1');
}

async function runSuite(repeat = 2) {
  const rounds = [];
  for (let round = 1; round <= Math.max(2, Number(repeat || 2)); round += 1) {
    rounds.push(await runRound(round));
  }
  const baseline = new Map(rounds[0].results.map((result) => [result.id, semanticFingerprint(result)]));
  const mismatches = rounds.slice(1).flatMap((round) => round.results
    .filter((result) => baseline.get(result.id) !== semanticFingerprint(result))
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

module.exports = {
  CASES,
  runSuite
};
