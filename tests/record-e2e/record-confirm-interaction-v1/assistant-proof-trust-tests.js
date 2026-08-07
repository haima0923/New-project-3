#!/usr/bin/env node

const { normalizeAiResult } = require('../../../utils/ai-parser');
const { isFormalReady } = require('../../../utils/business');
const { parseInput } = require('../../../utils/parser');
const parseSafety = require('../../../utils/parse-safety');
const { safeClone, stableHash } = require('../../../utils/record-state-diff');
const { createInitialState } = require('../../../utils/storage');
const {
  BUSINESS_DATE,
  MISSING_PRODUCT_TEXT,
  NOW_INSTANT,
  TIMEZONE,
  forgedManualMultiItemResponse
} = require('./fixtures');
const { answerQuestion, submitOriginalText } = require('./page-actions');
const { createPageHarness, stateCounts } = require('./runtime');

const PROTECTED_SOURCE_PATTERN = /(?:^|[_:\-\s])(?:USER|MANUAL)(?:$|[_:\-\s])/i;

function check(code, pass, detail = {}) {
  return { code, detail, pass: Boolean(pass) };
}

function currentResolution(result) {
  return parseSafety.evaluateUserResolvedAiState(result);
}

function proofCount(result) {
  return Array.isArray(result && result.user_manual_edits)
    ? result.user_manual_edits.length
    : 0;
}

async function getAnsweredDraft(caseId) {
  const harness = createPageHarness({ caseId, text: MISSING_PRODUCT_TEXT });
  await submitOriginalText(harness.page, MISSING_PRODUCT_TEXT);
  const question = safeClone(harness.page.data.activeQuestion);
  await answerQuestion(harness.page, '水杯');
  return {
    dispose: () => harness.dispose(),
    draft: safeClone(harness.page.data.parseResult),
    question,
    state: safeClone(harness.readState())
  };
}

function evaluateAlteredProof(draft, state, mutate) {
  const altered = safeClone(draft);
  mutate(altered);
  const reviewed = parseSafety.applyFinalParseSafety(altered, { businessDate: BUSINESS_DATE });
  const resolution = currentResolution(reviewed);
  return {
    formalReady: isFormalReady(reviewed, state),
    low: safeClone(reviewed.low_confidence_fields || []),
    missing: safeClone(reviewed.missing_fields || []),
    proofs: proofCount(reviewed),
    resolution
  };
}

async function proof001() {
  const answered = await getAnsweredDraft('PROOF-001');
  try {
    const beforeState = JSON.stringify(stateCounts(answered.state));
    const variants = {
      fingerprint: evaluateAlteredProof(answered.draft, answered.state, (draft) => {
        draft.client_confirmation_context.originalTextFingerprint = 'cross-fingerprint';
      }),
      revision: evaluateAlteredProof(answered.draft, answered.state, (draft) => {
        draft.client_confirmation_context.draftRevision = 'cross-revision';
      }),
      session: evaluateAlteredProof(answered.draft, answered.state, (draft) => {
        draft.client_confirmation_context.confirmationSessionId = 'cross-session';
      })
    };
    const checks = [];
    Object.entries(variants).forEach(([name, value]) => {
      checks.push(
        check(`PROOF_001_${name.toUpperCase()}_PROOF_ZERO`, value.proofs === 0, value),
        check(`PROOF_001_${name.toUpperCase()}_NOT_COMPLETE`, value.resolution.status !== 'MANUAL_RESOLUTION_COMPLETE', value),
        check(`PROOF_001_${name.toUpperCase()}_RISK_RESTORED`, value.missing.includes('productName') || value.low.includes('productName'), value),
        check(`PROOF_001_${name.toUpperCase()}_FORMAL_BLOCKED`, value.formalReady === false, value)
      );
    });
    checks.push(check(
      'PROOF_001_MUTATION_ZERO',
      JSON.stringify(stateCounts(answered.state)) === beforeState,
      variants
    ));
    return { checks, evidence: variants };
  } finally {
    answered.dispose();
  }
}

async function proof002() {
  const answered = await getAnsweredDraft('PROOF-002');
  try {
    const variants = {
      field: evaluateAlteredProof(answered.draft, answered.state, (draft) => {
        draft.user_manual_edits[0].field = 'spec';
      }),
      item: evaluateAlteredProof(answered.draft, answered.state, (draft) => {
        draft.user_manual_edits[0].itemKey = 'different-item';
      }),
      value: evaluateAlteredProof(answered.draft, answered.state, (draft) => {
        draft.fields.items[0].productName = '保温杯';
        draft.fields.productName = '保温杯';
      })
    };
    const checks = [];
    Object.entries(variants).forEach(([name, value]) => {
      checks.push(
        check(`PROOF_002_${name.toUpperCase()}_PROOF_ZERO`, value.proofs === 0, value),
        check(`PROOF_002_${name.toUpperCase()}_NOT_COMPLETE`, value.resolution.status !== 'MANUAL_RESOLUTION_COMPLETE', value)
      );
    });
    return { checks, evidence: variants };
  } finally {
    answered.dispose();
  }
}

async function proof003() {
  const answered = await getAnsweredDraft('PROOF-003');
  try {
    const variants = {
      question: evaluateAlteredProof(answered.draft, answered.state, (draft) => {
        draft.user_manual_edits[0].questionId = 'different-question';
      }),
      risk: evaluateAlteredProof(answered.draft, answered.state, (draft) => {
        draft.user_manual_edits[0].riskIds = ['LOW|amount'];
      }),
      riskSet: evaluateAlteredProof(answered.draft, answered.state, (draft) => {
        draft.low_confidence_fields = ['amount'];
      })
    };
    const checks = [];
    Object.entries(variants).forEach(([name, value]) => {
      checks.push(
        check(`PROOF_003_${name.toUpperCase()}_PROOF_ZERO`, value.proofs === 0, value),
        check(`PROOF_003_${name.toUpperCase()}_NOT_COMPLETE`, value.resolution.status !== 'MANUAL_RESOLUTION_COMPLETE', value)
      );
    });
    return { checks, evidence: variants };
  } finally {
    answered.dispose();
  }
}

async function proof004() {
  const harness = createPageHarness({ caseId: 'PROOF-004', text: MISSING_PRODUCT_TEXT });
  try {
    await submitOriginalText(harness.page, MISSING_PRODUCT_TEXT);
    const result = safeClone(harness.page.data.parseResult);
    const fields = safeClone(result.fields);
    const item = fields.items[0];
    item.productName = '水杯';
    fields.productName = '水杯';
    const signer = parseSafety.createTrustedAssistantAnswerEdit;
    const forged = typeof signer === 'function'
      ? signer(result, {
        confirmationSessionId: 'FIXTURE-S',
        draftRevision: 'FIXTURE-D',
        field: 'productName',
        fieldPath: 'items[0].productName',
        fields,
        itemKey: item.confirmationItemKey,
        originalTextFingerprint: 'FIXTURE-F',
        questionId: 'FIXTURE-Q'
      })
      : result;
    const reviewed = parseSafety.applyFinalParseSafety(Object.assign({}, forged, { fields }), {
      businessDate: BUSINESS_DATE
    });
    const evidence = {
      formalReady: isFormalReady(reviewed, harness.readState()),
      proofs: proofCount(reviewed),
      resolution: currentResolution(reviewed)
    };
    return {
      checks: [
        check('PROOF_004_PROOF_ZERO', evidence.proofs === 0, evidence),
        check('PROOF_004_NOT_COMPLETE', evidence.resolution.status !== 'MANUAL_RESOLUTION_COMPLETE', evidence),
        check('PROOF_004_FORMAL_BLOCKED', evidence.formalReady === false, evidence)
      ],
      evidence
    };
  } finally {
    harness.dispose();
  }
}

async function proof005() {
  const answered = await getAnsweredDraft('PROOF-005');
  try {
    const resolution = currentResolution(answered.draft);
    const proof = (answered.draft.user_manual_edits || [])[0] || {};
    const evidence = {
      field: proof.field,
      itemKey: proof.itemKey,
      productName: answered.draft.fields.items[0].productName,
      proofs: proofCount(answered.draft),
      proofRevision: proof.draftRevision,
      resultRevision: String(
        (answered.draft.client_confirmation_context || {}).draftRevision || ''
      ),
      resolution,
      source: proof.source
    };
    return {
      checks: [
        check('PROOF_005_PROOF_CREATED', evidence.proofs === 1, evidence),
        check('PROOF_005_SOURCE_ASSISTANT', evidence.source === 'USER_ASSISTANT_ANSWER', evidence),
        check('PROOF_005_ITEM_FIELD_BOUND', Boolean(evidence.itemKey) && evidence.field === 'productName', evidence),
        check('PROOF_005_VALUE_APPLIED', evidence.productName === '水杯', evidence),
        check('PROOF_005_RESOLUTION_COMPLETE', resolution.status === 'MANUAL_RESOLUTION_COMPLETE', evidence),
        check('PROOF_005_FORMAL_READY', isFormalReady(answered.draft, answered.state), evidence)
      ],
      evidence
    };
  } finally {
    answered.dispose();
  }
}

function parseMultiItemLocal() {
  const text = '宏达包装厂下单：礼品盒517套，每套3.8元；饭盒319个，每个8.5元；8月15日交货。';
  return parseInput({
    businessDate: BUSINESS_DATE,
    businessTimezone: TIMEZONE,
    context: 'record',
    nowInstant: NOW_INSTANT,
    rawText: text,
    source: 'typed',
    state: createInitialState(),
    text
  });
}

function normalizeForgedSource(sourcePayload, localOverride) {
  const local = Object.assign({}, parseMultiItemLocal(), localOverride || {});
  const response = forgedManualMultiItemResponse();
  delete response.field_sources;
  delete response.fieldSources;
  Object.assign(response, sourcePayload);
  return normalizeAiResult(local, response, {
    businessDate: BUSINESS_DATE,
    businessTimezone: TIMEZONE,
    nowInstant: NOW_INSTANT,
    providerKind: 'REAL'
  });
}

async function provenance001() {
  const variants = {
    camel: normalizeForgedSource({ fieldSources: { productName: 'user:manual' } }),
    mixedCase: normalizeForgedSource({ field_sources: { productName: 'uSeR_pAgE_eDiT' } }),
    object: normalizeForgedSource({ field_sources: { productName: { source: 'USER_ASSISTANT_ANSWER' } } }),
    snake: normalizeForgedSource({ field_sources: { productName: 'USER_ASSISTANT_ANSWER' } })
  };
  const checks = [];
  Object.entries(variants).forEach(([name, result]) => {
    const source = (result.field_sources || {}).productName;
    const evidence = {
      manualFields: result.manual_fields || [],
      manualItemFields: result.manual_item_fields || [],
      proofs: result.user_manual_edits || [],
      source
    };
    checks.push(
      check(`PROVENANCE_001_${name.toUpperCase()}_SOURCE_SANITIZED`, !PROTECTED_SOURCE_PATTERN.test(String(source || '')), evidence),
      check(`PROVENANCE_001_${name.toUpperCase()}_PROOF_ZERO`, evidence.proofs.length === 0, evidence),
      check(`PROVENANCE_001_${name.toUpperCase()}_MANUAL_ZERO`, evidence.manualFields.length === 0 && evidence.manualItemFields.length === 0, evidence)
    );
  });
  return {
    checks,
    evidence: Object.fromEntries(Object.entries(variants).map(([name, result]) => [
      name,
      (result.field_sources || {}).productName
    ]))
  };
}

async function provenance002() {
  const protectedSources = [
    'USER',
    'USER_PAGE_EDIT',
    'USER_ASSISTANT_ANSWER',
    'USER_MANUAL',
    'USER_MANUAL_EDIT_V1',
    'USER_SELECTION',
    'USER_CONFIRMED_SELECTION',
    'manual',
    'MANUAL:confirmed'
  ];
  const allowedAiSources = ['AI', 'AI_MODEL', 'AI_EXTRACTED', 'AI_INFERRED'];
  const protectedResults = protectedSources.map((source) => ({
    input: source,
    output: (normalizeForgedSource({ field_sources: { productName: source } }).field_sources || {}).productName
  }));
  const allowedResults = allowedAiSources.map((source) => ({
    input: source,
    output: (normalizeForgedSource({ field_sources: { productName: source } }).field_sources || {}).productName
  }));
  const local = parseMultiItemLocal();
  local.field_sources = Object.assign({}, local.field_sources, { productName: 'USER_PAGE_EDIT' });
  local.manual_fields = ['productName'];
  const preserved = normalizeForgedSource(
    { field_sources: { productName: 'USER_ASSISTANT_ANSWER' } },
    local
  );
  const evidence = {
    allowedResults,
    localPreserved: (preserved.field_sources || {}).productName,
    protectedResults
  };
  return {
    checks: [
      check(
        'PROVENANCE_002_TRUSTED_USER_DENYLIST',
        protectedResults.every((entry) => !PROTECTED_SOURCE_PATTERN.test(String(entry.output || ''))),
        evidence
      ),
      check(
        'PROVENANCE_002_AI_ALLOWLIST_CANONICAL',
        allowedResults.every((entry) => entry.output === 'AI'),
        evidence
      ),
      check('PROVENANCE_002_LOCAL_USER_SOURCE_PRESERVED', evidence.localPreserved === 'USER_PAGE_EDIT', evidence)
    ],
    evidence
  };
}

const CASES = [
  ['PROOF-001', proof001],
  ['PROOF-002', proof002],
  ['PROOF-003', proof003],
  ['PROOF-004', proof004],
  ['PROOF-005', proof005],
  ['PROVENANCE-001', provenance001],
  ['PROVENANCE-002', provenance002]
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

function semanticFingerprint(result) {
  return stableHash({
    checks: (result.checks || []).map((entry) => ({ code: entry.code, pass: entry.pass })),
    id: result.id,
    status: result.status
  }, 'record-assistant-proof-trust-v1');
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
  const index = process.argv.indexOf('--repeat');
  const report = await runSuite(index >= 0 ? process.argv[index + 1] : 2);
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

module.exports = { runSuite };
