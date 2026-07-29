#!/usr/bin/env node
const assert = require('assert');
const { loadCorpus } = require('../runner/load-corpus');
const { expectedProposal } = require('../runner/observation-semantics');
const { runSuite } = require('../runner/run-suite');

const FINANCIAL_BUSINESS_TYPES = new Set([
  'order_deposit',
  'payment',
  'receivable',
  'todo'
]);
const FINANCIAL_OPERATIONS = new Set([
  'create_receivable',
  'create_todo',
  'record_order_deposit',
  'record_payment'
]);

function isFinancialCase(testCase) {
  const proposal = expectedProposal(testCase);
  const expectedFields = testCase.expected
    && testCase.expected.result
    && testCase.expected.result.fields || {};
  return FINANCIAL_BUSINESS_TYPES.has(proposal.businessType)
    && (
      FINANCIAL_OPERATIONS.has(proposal.operation)
      || expectedFields.todoType === 'dunning'
      || testCase.category === 'FINANCIAL_SAFETY'
    );
}

function canonicalRawResults(result) {
  const summary = result.observationSemantics
    && result.observationSemantics.rawParser
    && result.observationSemantics.rawParser.summary;
  return summary && Array.isArray(summary.canonicalLocalResults)
    ? summary.canonicalLocalResults.map((entry) => entry.resultSummary)
    : [];
}

async function main() {
  const corpus = loadCorpus();
  const selected = corpus.activeCases
    .filter(isFinancialCase)
    .sort((left, right) => left.caseId.localeCompare(right.caseId));
  assert(selected.length, 'financial adjacent selection must not be empty');
  const rows = [];
  for (const testCase of selected) {
    const run = await runSuite({
      caseId: testCase.caseId,
      corpus,
      repeat: 1
    });
    const result = run.attempts[0].results[0];
    assert.notStrictEqual(result.caseStatus, 'RUNNER_ERROR', `${testCase.caseId}: runner error`);
    assert.notStrictEqual(result.caseStatus, 'BLOCKED', `${testCase.caseId}: blocked`);
    const rawResults = canonicalRawResults(result);
    const semantic = result.observationSemantics
      && result.observationSemantics.semanticResult || {};
    const outcome = result.observationSemantics
      && result.observationSemantics.outcome || {};
    rows.push({
      blockingCodes: (result.preflightEvidence
        && result.preflightEvidence.blockingCodes || []).slice(),
      businessDiffChangedCollections: Object.entries(result.businessDiff || {})
        .filter(([, diff]) => diff && (
          (diff.created || []).length
          || (diff.deleted || []).length
          || (diff.updated || []).length
        ))
        .map(([collection]) => collection),
      caseId: testCase.caseId,
      caseStatus: result.caseStatus,
      effectiveOperation: semantic.effectiveOperation || '',
      failureStage: result.failureStage || '',
      outcomeDisposition: outcome.disposition || '',
      rawBusinessTypes: Array.from(new Set(
        rawResults.map((item) => item.businessType || item.intent || 'unknown')
      )),
      rawOperations: Array.from(new Set(
        rawResults.map((item) => item.operation || null)
      )),
      semanticBusinessType: semantic.businessType || ''
    });
  }
  console.log(JSON.stringify({
    caseCount: rows.length,
    rows
  }, null, 2));
  console.log(`Payment/financial adjacent E2E tests: ${rows.length}/${rows.length} executed`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
