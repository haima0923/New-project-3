#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('../../../scripts/run-record-e2e-headless');
const { classifyFailureOwnership } = require('../runner/classify-failure-ownership');
const { clusterFailures } = require('../runner/cluster-failures');
const {
  assertP1SampleCoverage,
  assertRerunCoverage,
  chooseP1Sample,
  compareResultOrThrow,
  filterResults,
  summarizeDimensions
} = require('../runner/full-corpus-baseline');
const {
  auditPaymentCommits,
  assertFullAttemptIntegrity,
  exactUniqueSet
} = require('../runner/full-run-integrity');
const { sanitizeEvidence } = require('../runner/sanitize-evidence');
const { validateOutputPath, writeFullReport } = require('../runner/write-full-report');
const { countStaleSessionAccepted } = require('../runner/create-fake-voice');

function lane(name = 'PAGE_PRODUCTION_OBSERVATION') {
  return {
    assertionStatus: 'PASS',
    executionStatus: 'PASS',
    lane: name,
    status: 'PASS'
  };
}

function cleanResult(caseId, laneName = 'PAGE_PRODUCTION_OBSERVATION') {
  return {
    assertions: [],
    caseId,
    caseStatus: 'PASS',
    finalTransactionAudit: { backupCount: 0, journalCount: 0 },
    fixtureMutationAudit: {
      afterFingerprint: `fixture:${caseId}`,
      beforeFingerprint: `fixture:${caseId}`,
      unchanged: true
    },
    hostFilesystemAudit: {
      auditPerformed: true,
      guardInstalled: true,
      hostFilesystemStorageCalls: 0
    },
    isolationAuditCompletion: {
      fixtureAuditCompleted: true,
      journalBackupAuditCompleted: true,
      networkAuditCompleted: true,
      storageAuditCompleted: true,
      workerCleanupCompleted: true
    },
    laneResults: [lane(laneName)],
    networkAudit: {
      auditPerformed: true,
      guardInstalled: true,
      realNetworkRequests: 0,
      unknownFakeRouteRequests: 0
    },
    observationSemantics: {
      rawParser: {
        collectionCompleted: true,
        directRawInvocations: [],
        errors: [],
        hybridInvocations: [{
          hybridInvocationId: 'hybrid-1',
          rawInvocations: [{
            completed: true,
            globalSequence: 1,
            parentDirectRawInvocationId: null,
            parentHybridInvocationId: 'hybrid-1',
            rawInvocationId: 'raw-1',
            started: true
          }]
        }],
        instrumentationInstalled: true,
        instrumentationInstalledBeforeAiParserLoad: true,
        orphanRawInvocations: [],
        rawInvocationCount: 1,
        shadowParserInvocations: [],
        status: 'RAW_PARSER_INVOKED',
        uncorrelatedInvocationCount: 0,
        validationCompleted: true
      }
    },
    routeEvidence: {
      aiQuotationIdPromotedCount: 0,
      dangerousQuotationFieldInheritanceCount: 0,
      dangerousQuotationSelectedCount: 0,
      quotationAutoSelectionCount: 0,
      quotationSelectionMissingCount: 0,
      unconfirmedQuotationIdAcceptedCount: 0
    },
    runtimeEvidence: { workerIsolation: 'DEDICATED_CHILD_PROCESS' },
    storageAudit: {
      auditPerformed: true,
      fakeWxBrandVerifiedEnd: true,
      fakeWxBrandVerifiedStart: true,
      realWxStorageCalls: 0
    },
    workerExitAudit: { exitCode: 0, exitObserved: true, ipcClosed: true }
  };
}

function failure(caseId, overrides = {}) {
  return Object.assign(cleanResult(caseId), {
    aiProfile: 'LOCAL_ONLY',
    businessType: 'order',
    caseStatus: 'CASE_FAIL',
    category: 'formal-basic',
    entrySurface: 'HOME_QUICK',
    expectedRoute: 'LOCAL',
    failureCode: 'ASSERTION_FAILED:fields.product',
    failureOwnership: 'UNCLASSIFIED_REQUIRES_REVIEW',
    failureStage: 'LOCAL_PARSE_ERROR',
    inputChannel: 'TYPED_TEXT',
    requiredCapabilities: [],
    riskLevel: 'P1'
  }, overrides);
}

function linkedPaymentResult(overrides = {}) {
  const result = cleanResult('PAYMENT-CASE');
  const amount = overrides.amount === undefined ? 20 : overrides.amount;
  const beforePaid = overrides.beforePaid === undefined ? 10 : overrides.beforePaid;
  const total = overrides.total === undefined ? 100 : overrides.total;
  const afterPaid = overrides.afterPaid === undefined
    ? Number(beforePaid) + Number(amount)
    : overrides.afterPaid;
  const kind = overrides.kind || 'partial_payment';
  const paymentCount = overrides.paymentCount || 1;
  result.routeEvidence = Object.assign({}, result.routeEvidence, {
    effectiveOperation: 'record_payment'
  });
  result.businessDiff = {
    payments: {
      created: Array.from({ length: paymentCount }, (_, index) => ({
        amount,
        id: `payment-${index + 1}`,
        kind,
        receivableId: 'receivable-1'
      }))
    },
    receivables: {
      updated: [{
        after: {
          amount: total,
          paidAmount: afterPaid,
          status: Number(afterPaid) === Number(total) ? '已结清' : '部分收款'
        },
        before: {
          amount: total,
          paidAmount: beforePaid,
          status: beforePaid > 0 ? '部分收款' : '待收款'
        },
        id: 'receivable-1'
      }]
    }
  };
  return result;
}

function expectThrow(fn, failureCode) {
  assert.throws(fn, (error) => (
    error.failureCode === failureCode || error.code === failureCode
  ));
}

const tests = [
  {
    name: 'full-attempt-requires-exactly-120-cases',
    run() {
      const plans = Array.from({ length: 120 }, (_, index) => ({
        testCase: {
          caseId: `CASE-${String(index + 1).padStart(3, '0')}`,
          execution: { lanes: ['PAGE_PRODUCTION_OBSERVATION'] }
        }
      }));
      const results = plans.map((item) => cleanResult(item.testCase.caseId));
      const audit = assertFullAttemptIntegrity({ attempt: 1, results }, plans);
      assert.strictEqual(audit.caseCount, 120);
      expectThrow(
        () => assertFullAttemptIntegrity({ attempt: 1, results: results.slice(0, 119) }, plans),
        'FULL_CORPUS_CASE_SET_MISMATCH'
      );
    }
  },
  {
    name: 'duplicate-case-result-is-rejected',
    run() {
      expectThrow(
        () => exactUniqueSet(['A', 'A'], ['A', 'B'], 'DUPLICATE', 'Case'),
        'DUPLICATE'
      );
    }
  },
  {
    name: 'lane-set-must-match-contract',
    run() {
      const plans = [{
        testCase: {
          caseId: 'CASE-A',
          execution: { lanes: ['PAGE_PRODUCTION_OBSERVATION'] }
        }
      }];
      const result = cleanResult('CASE-A', 'TEST_ONLY_ISOLATED_LEGACY_COMMIT');
      expectThrow(
        () => assertFullAttemptIntegrity({ attempt: 1, results: [result] }, plans),
        'FULL_CORPUS_LANE_SET_MISMATCH'
      );
    }
  },
  {
    name: 'determinism-semantic-drift-is-rejected',
    run() {
      const baseline = failure('CASE-A');
      const rerun = failure('CASE-A', { failureStage: 'ROUTE_ERROR' });
      expectThrow(
        () => compareResultOrThrow(baseline, rerun, 'self-test'),
        'DETERMINISM_MISMATCH'
      );
    }
  },
  {
    name: 'determinism-parser-invocation-graph-drift-is-rejected',
    run() {
      const baseline = cleanResult('CASE-A');
      const rerun = cleanResult('CASE-A');
      rerun.observationSemantics.rawParser.hybridInvocations[0]
        .rawInvocations.push({
          completed: true,
          globalSequence: 2,
          parentDirectRawInvocationId: null,
          parentHybridInvocationId: 'hybrid-1',
          rawInvocationId: 'raw-2',
          started: true
        });
      rerun.observationSemantics.rawParser.rawInvocationCount = 2;
      expectThrow(
        () => compareResultOrThrow(baseline, rerun, 'parser graph self-test'),
        'PARSER_INVOCATION_GRAPH_DETERMINISM_MISMATCH'
      );
    }
  },
  {
    name: 'full-attempt-rejects-missing-parser-evidence',
    run() {
      const plans = [{
        testCase: {
          caseId: 'CASE-A',
          execution: { lanes: ['PAGE_PRODUCTION_OBSERVATION'] }
        }
      }];
      const result = cleanResult('CASE-A');
      result.observationSemantics.rawParser.status = 'RAW_PARSER_EVIDENCE_MISSING';
      expectThrow(
        () => assertFullAttemptIntegrity({ attempt: 1, results: [result] }, plans),
        'RAW_PARSER_EVIDENCE_MISSING'
      );
    }
  },
  {
    name: 'full-attempt-rejects-stale-voice-session-acceptance',
    run() {
      const plans = [{
        testCase: {
          caseId: 'CASE-A',
          execution: { lanes: ['PAGE_PRODUCTION_OBSERVATION'] }
        }
      }];
      const result = cleanResult('CASE-A');
      result.voiceAudit = { staleSessionAcceptedCount: 1 };
      expectThrow(
        () => assertFullAttemptIntegrity({ attempt: 1, results: [result] }, plans),
        'VOICE_STALE_SESSION_ACCEPTED'
      );
    }
  },
  {
    name: 'full-attempt-rejects-duplicate-voice-standard-ai-request',
    run() {
      const plans = [{
        testCase: {
          caseId: 'CASE-A',
          execution: { lanes: ['PAGE_PRODUCTION_OBSERVATION'] }
        }
      }];
      const result = cleanResult('CASE-A');
      result.voiceCompletionEvidence = {
        duplicateVoiceStandardAIRequestCount: 1
      };
      expectThrow(
        () => assertFullAttemptIntegrity({ attempt: 1, results: [result] }, plans),
        'DUPLICATE_VOICE_STANDARD_AI_REQUEST'
      );
    }
  },
  {
    name: 'full-attempt-rejects-quotation-deep-and-trust-boundary-counter-regressions',
    run() {
      const plans = [{
        testCase: {
          caseId: 'CASE-A',
          execution: { lanes: ['PAGE_PRODUCTION_OBSERVATION'] }
        }
      }];
      [
        ['duplicateDeepReviewInvocationCount', 'DUPLICATE_DEEP_REVIEW_INVOCATION'],
        ['duplicateDeepAIRequestCount', 'DUPLICATE_DEEP_AI_REQUEST'],
        ['quotationLocalEvidenceDropCount', 'QUOTATION_LOCAL_EVIDENCE_DROPPED'],
        ['untrustedQuotationIdPromotionCount', 'UNTRUSTED_QUOTATION_ID_PROMOTED'],
        ['unconfirmedQuotationIdAcceptedCount', 'UNCONFIRMED_QUOTATION_ID_ACCEPTED'],
        ['aiQuotationIdPromotedCount', 'AI_QUOTATION_ID_PROMOTED'],
        ['dangerousQuotationSelectedCount', 'DANGEROUS_QUOTATION_SELECTED'],
        ['dangerousQuotationFieldInheritanceCount', 'DANGEROUS_QUOTATION_FIELD_INHERITED'],
        ['quotationAutoSelectionCount', 'QUOTATION_AUTO_SELECTED'],
        ['quotationSelectionMissingCount', 'QUOTATION_SELECTION_REQUIREMENT_MISSING']
      ].forEach(([field, code]) => {
        const result = cleanResult('CASE-A');
        result.routeEvidence[field] = 1;
        expectThrow(
          () => assertFullAttemptIntegrity({ attempt: 1, results: [result] }, plans),
          code
        );
      });
    }
  },
  {
    name: 'full-attempt-rejects-missing-quotation-trust-audit-counters',
    run() {
      const plans = [{
        testCase: {
          caseId: 'CASE-A',
          execution: { lanes: ['PAGE_PRODUCTION_OBSERVATION'] }
        }
      }];
      const result = cleanResult('CASE-A');
      delete result.routeEvidence.dangerousQuotationFieldInheritanceCount;
      expectThrow(
        () => assertFullAttemptIntegrity({ attempt: 1, results: [result] }, plans),
        'QUOTATION_TRUST_AUDIT_MISSING'
      );
    }
  },
  {
    name: 'full-attempt-requires-one-user-initiated-deep-for-explicit-quotation-conversion',
    run() {
      const plans = [{
        testCase: {
          caseId: 'CASE-A',
          execution: { lanes: ['PAGE_PRODUCTION_OBSERVATION'] }
        }
      }];
      const result = cleanResult('CASE-A');
      result.routeEvidence = Object.assign({}, result.routeEvidence, {
        actualRoute: 'PENDING',
        AIRequestCount: 0,
        deepAIRequestCount: 0,
        duplicateDeepAIRequestCount: 0,
        duplicateDeepReviewInvocationCount: 0,
        initialDeepReviewAvailable: true,
        initialRoute: 'PENDING',
        quotationConversionDeepReviewEligible: true,
        quotationLocalEvidenceDropCount: 0,
        requestDeepReviewInvocationCount: 1,
        secondHybridInvocationCount: 1,
        standardAIRequestCount: 0,
        untrustedQuotationIdPromotionCount: 0
      });
      expectThrow(
        () => assertFullAttemptIntegrity({ attempt: 1, results: [result] }, plans),
        'QUOTATION_CONVERSION_DEEP_REVIEW_COUNT_MISMATCH'
      );
    }
  },
  {
    name: 'full-attempt-reports-zero-payment-balance-integrity-counts',
    run() {
      const plans = [{
        testCase: {
          caseId: 'PAYMENT-CASE',
          execution: { lanes: ['PAGE_PRODUCTION_OBSERVATION'] }
        }
      }];
      const result = linkedPaymentResult();
      assert.deepStrictEqual(auditPaymentCommits(result), {
        duplicatePaymentCommitCount: 0,
        overpaymentCommitCount: 0,
        paymentKindBalanceMismatchCount: 0
      });
      assert.deepStrictEqual(auditPaymentCommits(linkedPaymentResult({
        afterPaid: 100,
        amount: 90,
        kind: 'final_payment'
      })), {
        duplicatePaymentCommitCount: 0,
        overpaymentCommitCount: 0,
        paymentKindBalanceMismatchCount: 0
      });
      const audit = assertFullAttemptIntegrity({ attempt: 1, results: [result] }, plans);
      assert.strictEqual(audit.duplicateDeepAIRequestCount, 0);
      assert.strictEqual(audit.duplicateDeepReviewInvocationCount, 0);
      assert.strictEqual(audit.duplicatePaymentCommitCount, 0);
      assert.strictEqual(audit.paymentKindBalanceMismatchCount, 0);
      assert.strictEqual(audit.quotationLocalEvidenceDropCount, 0);
      assert.strictEqual(audit.overpaymentCommitCount, 0);
      assert.strictEqual(audit.untrustedQuotationIdPromotionCount, 0);
      assert.strictEqual(audit.unconfirmedQuotationIdAcceptedCount, 0);
      assert.strictEqual(audit.aiQuotationIdPromotedCount, 0);
      assert.strictEqual(audit.dangerousQuotationSelectedCount, 0);
      assert.strictEqual(audit.dangerousQuotationFieldInheritanceCount, 0);
      assert.strictEqual(audit.quotationAutoSelectionCount, 0);
      assert.strictEqual(audit.quotationSelectionMissingCount, 0);
    }
  },
  {
    name: 'full-attempt-rejects-payment-kind-balance-mismatch',
    run() {
      const plans = [{
        testCase: {
          caseId: 'PAYMENT-CASE',
          execution: { lanes: ['PAGE_PRODUCTION_OBSERVATION'] }
        }
      }];
      const result = linkedPaymentResult({ kind: 'final_payment' });
      expectThrow(
        () => assertFullAttemptIntegrity({ attempt: 1, results: [result] }, plans),
        'PAYMENT_KIND_BALANCE_MISMATCH'
      );
    }
  },
  {
    name: 'full-attempt-rejects-duplicate-linked-payment-commit',
    run() {
      const plans = [{
        testCase: {
          caseId: 'PAYMENT-CASE',
          execution: { lanes: ['PAGE_PRODUCTION_OBSERVATION'] }
        }
      }];
      const result = linkedPaymentResult({ paymentCount: 2 });
      expectThrow(
        () => assertFullAttemptIntegrity({ attempt: 1, results: [result] }, plans),
        'DUPLICATE_PAYMENT_COMMIT_DETECTED'
      );
    }
  },
  {
    name: 'full-attempt-rejects-overpayment-commit',
    run() {
      const plans = [{
        testCase: {
          caseId: 'PAYMENT-CASE',
          execution: { lanes: ['PAGE_PRODUCTION_OBSERVATION'] }
        }
      }];
      const result = linkedPaymentResult({ amount: 91, afterPaid: 101 });
      expectThrow(
        () => assertFullAttemptIntegrity({ attempt: 1, results: [result] }, plans),
        'OVERPAYMENT_COMMIT_DETECTED'
      );
    }
  },
  {
    name: 'full-attempt-requires-exactly-one-ai-request-for-eligible-voice-standard',
    run() {
      const plans = [{
        testCase: {
          caseId: 'CASE-A',
          execution: { lanes: ['PAGE_PRODUCTION_OBSERVATION'] }
        }
      }];
      const result = cleanResult('CASE-A');
      result.voiceCompletionEvidence = {
        actualRoute: 'AI_STANDARD',
        AIRequestCount: 0,
        deepAIRequestCount: 0,
        duplicateVoiceStandardAIRequestCount: 0,
        standardAIRequestCount: 0,
        voiceStandardEligible: true
      };
      expectThrow(
        () => assertFullAttemptIntegrity({ attempt: 1, results: [result] }, plans),
        'VOICE_STANDARD_AI_REQUEST_COUNT_MISMATCH'
      );
    }
  },
  {
    name: 'stale-voice-session-count-compares-provider-generation-to-accepted-session',
    run() {
      const events = [{
        type: 'FINAL_CALLBACK',
        recordVoiceSessionId: 'voice-session-A'
      }];
      assert.strictEqual(countStaleSessionAccepted(events, {
        acceptedFinalCount: 1,
        evidence: { sessionId: 'voice-session-B' }
      }), 1);
      assert.strictEqual(countStaleSessionAccepted(events, {
        acceptedFinalCount: 1,
        evidence: { sessionId: 'voice-session-A' }
      }), 0);
    }
  },
  {
    name: 'all-p0-failures-require-reruns',
    run() {
      const expected = [failure('P0-A', { riskLevel: 'P0' }), failure('P0-B', { riskLevel: 'P0' })];
      expectThrow(
        () => assertRerunCoverage(expected, [{ caseId: 'P0-A' }], 'P0'),
        'RERUN_COVERAGE_ERROR'
      );
      assert.doesNotThrow(() => assertRerunCoverage(
        expected,
        [{ caseId: 'P0-A' }, { caseId: 'P0-B' }],
        'P0'
      ));
    }
  },
  {
    name: 'p1-sample-covers-stage-ownership-and-category',
    run() {
      const failures = Array.from({ length: 12 }, (_, index) => failure(`P1-${index}`, {
        category: index % 2 ? 'financial-safety' : 'formal-basic',
        failureOwnership: index % 3
          ? 'UNCLASSIFIED_REQUIRES_REVIEW'
          : 'EXPECTED_MAPPING_MISMATCH_CANDIDATE',
        failureStage: index % 2 ? 'STATE_DIFF_ERROR' : 'LOCAL_PARSE_ERROR'
      }));
      const sample = chooseP1Sample(failures);
      assert(sample.length >= 10);
      assert.doesNotThrow(() => assertP1SampleCoverage(failures, sample));
      expectThrow(
        () => assertP1SampleCoverage(failures, sample.filter((item) => (
          item.category !== 'financial-safety'
        ))),
        'P1_SAMPLE_COVERAGE_ERROR'
      );
    }
  },
  {
    name: 'cluster-covers-every-case-once',
    run() {
      const failures = [failure('CASE-A'), failure('CASE-B')];
      const report = clusterFailures(failures);
      assert.strictEqual(report.clusteredCaseCount, 2);
      expectThrow(
        () => clusterFailures([failure('CASE-A'), failure('CASE-A')]),
        'CLUSTER_COVERAGE_ERROR'
      );
    }
  },
  {
    name: 'cluster-never-mixes-failure-ownership',
    run() {
      const routeA = failure('CASE-A', {
        failureOwnership: 'UNCLASSIFIED_REQUIRES_REVIEW',
        failureStage: 'ROUTE_ERROR',
        routeEvidence: { actualRoute: 'PENDING' }
      });
      const routeB = failure('CASE-B', {
        failureOwnership: 'TEST_CONTRACT_MISMATCH_CANDIDATE',
        failureStage: 'ROUTE_ERROR',
        routeEvidence: { actualRoute: 'PENDING' }
      });
      const report = clusterFailures([routeA, routeB]);
      assert.strictEqual(report.clusters.length, 2);
      assert(report.clusters.every((cluster) => cluster.caseCount === 1));
    }
  },
  {
    name: 'candidate-observability-difference-is-not-confirmed-product-defect',
    run() {
      const testCase = {
        ai: { profile: 'LOCAL_ONLY' },
        caseId: 'CASE-A',
        expected: { preflight: {}, route: 'LOCAL' },
        input: { entrySurface: 'HEADLESS', originalText: '合成输入' }
      };
      const result = failure('CASE-A', {
        assertions: [{
          layer: 'STATE_DIFF',
          name: 'operationLogs.createdCount',
          pass: false
        }],
        failureStage: 'STATE_DIFF_ERROR'
      });
      const classified = classifyFailureOwnership(testCase, result);
      assert.strictEqual(
        classified.failureOwnership,
        'OBSERVABILITY_EXPECTATION_MISMATCH'
      );
      assert(!classified.failureOwnership.startsWith('CONFIRMED_PRODUCT_'));
    }
  },
  {
    name: 'lane-execution-pass-and-case-assertion-fail-are-separated',
    run() {
      const result = failure('CASE-A');
      result.laneResults[0] = Object.assign(result.laneResults[0], {
        assertionStatus: 'FAIL',
        executionStatus: 'PASS',
        status: 'CASE_FAIL'
      });
      const dimensions = summarizeDimensions([result]);
      const laneSummary = dimensions.executionLane.PAGE_PRODUCTION_OBSERVATION;
      assert.strictEqual(laneSummary.executionPass, 1);
      assert.strictEqual(laneSummary.assertionFail, 1);
      assert.strictEqual(laneSummary.CASE_FAIL, 1);
    }
  },
  {
    name: 'report-sanitizer-redacts-secret-shaped-values',
    run() {
      const sanitized = sanitizeEvidence({
        authorization: 'Bearer dangerous-secret',
        nested: { apiKey: 'sk-abcdefghijklmnop', text: 'Bearer dangerous-secret' }
      });
      assert.strictEqual(sanitized.authorization, '[REDACTED]');
      assert.strictEqual(sanitized.nested.apiKey, '[REDACTED]');
      assert.strictEqual(sanitized.nested.text, 'Bearer [REDACTED]');
    }
  },
  {
    name: 'report-path-must-be-absolute-temp-and-outside-repository',
    run() {
      assert.throws(() => validateOutputPath('report.json'));
      assert.throws(() => validateOutputPath(path.resolve('report.json')));
      assert.strictEqual(
        validateOutputPath('/private/tmp/record-e2e-report-self-test.json'),
        '/private/tmp/record-e2e-report-self-test.json'
      );
    }
  },
  {
    name: 'report-is-created-only-for-explicit-output-and-remains-sanitized',
    run() {
      const args = parseArgs(['--all', '--repeat', '2']);
      assert.strictEqual(args.output, '');
      const outputPath = `/private/tmp/record-e2e-report-self-test-${process.pid}.json`;
      const written = writeFullReport(outputPath, { token: 'danger', value: 1 });
      try {
        assert.strictEqual(written.path, outputPath);
        const report = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
        assert.strictEqual(report.token, '[REDACTED]');
      } finally {
        fs.unlinkSync(outputPath);
      }
    }
  },
  {
    name: 'full-cli-requires-exactly-two-attempts',
    run() {
      assert.throws(() => parseArgs(['--all']));
      assert.throws(() => parseArgs(['--all', '--repeat', '3']));
      assert.strictEqual(parseArgs(['--all', '--repeat', '2']).all, true);
    }
  },
  {
    name: 'result-filters-do-not-change-underlying-case-results',
    run() {
      const results = [
        failure('P0-A', { riskLevel: 'P0' }),
        failure('P1-A', { riskLevel: 'P1' })
      ];
      const filtered = filterResults(results, { risk: 'P0' });
      assert.deepStrictEqual(filtered.map((item) => item.caseId), ['P0-A']);
      assert.strictEqual(results.length, 2);
    }
  }
];

async function main() {
  let passed = 0;
  for (const test of tests) {
    await test.run();
    passed += 1;
    console.log(`PASS ${test.name}`);
  }
  console.log(`Record E2E full corpus/report self-tests: ${passed}/${tests.length} passed`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  cleanResult,
  failure,
  tests
};
