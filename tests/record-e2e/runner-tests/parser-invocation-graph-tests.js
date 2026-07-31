#!/usr/bin/env node
const assert = require('assert');
const { safeClone } = require('../../../utils/record-state-diff');
const {
  canonicalSemanticResult
} = require('../runner/observation-semantics');
const {
  collectParserObservationSince,
  loadObservedAiParser,
  observeHybridInvocationForTest,
  observeRawInvocationForTest,
  parserObservationCursor
} = require('../runner/observed-ai-parser');
const { runSuite } = require('../runner/run-suite');
const {
  CONVERSATION_ROLES,
  validateParserInvocationGraph
} = require('../runner/validate-parser-invocation-graph');

function resultSummary(intent = 'order') {
  return {
    businessType: intent,
    confidence: 0.9,
    intent,
    missingFields: [],
    operation: null,
    safetyStatus: 'SAFE_LOCAL'
  };
}

function makeRaw(id, parentId, sequence, role) {
  return {
    calledFunction: 'parseInput',
    callSite: [`${role}:1`],
    completed: true,
    failure: null,
    globalSequence: Number(id.replace(/\D/g, '')),
    inputFingerprint: `input-${id}`,
    inputKind: role === 'HYBRID_PRIMARY_LOCAL_PARSE'
      ? 'HYBRID_FULL_INPUT'
      : 'BUSINESS_TEXT_FRAGMENT',
    inputLength: 8,
    parentDirectRawInvocationId: null,
    parentHybridInvocationId: parentId,
    rawInvocationId: id,
    resultSummary: resultSummary(),
    role,
    sequenceInDirectRaw: null,
    sequenceInHybrid: sequence,
    started: true
  };
}

function makeHybrid(index, messageCount = 0, phase = 'INITIAL_PARSE', rawStart = 1) {
  const id = `hybrid-${index}`;
  const roles = ['HYBRID_PRIMARY_LOCAL_PARSE'];
  for (let pass = 0; pass < CONVERSATION_ROLES.length; pass += 1) {
    for (let message = 0; message < messageCount; message += 1) {
      roles.push(CONVERSATION_ROLES[pass]);
    }
  }
  const rawInvocations = roles.map((role, offset) => (
    makeRaw(`raw-${rawStart + offset}`, id, offset + 1, role)
  ));
  return {
    actualPageMethods: phase === 'DEEP_REVIEW'
      ? ['requestDeepReview', 'runParse']
      : ['pasteClipboard', 'readClipboardToInput', 'runParse'],
    callerAction: phase === 'DEEP_REVIEW' ? 'requestDeepReview' : 'pasteClipboard',
    completed: true,
    failure: null,
    hybridInvocationId: id,
    inputFingerprint: 'hybrid-input',
    inputKind: messageCount ? 'MULTI_MESSAGE_CLIPBOARD' : 'BUSINESS_TEXT',
    inputLength: 32,
    phase,
    rawCardinalityExpectation: {
      expectedCount: 1 + (4 * messageCount),
      policy: messageCount ? 'DERIVED_FROM_INPUT_STRUCTURE' : 'EXACTLY_ONE',
      rawMessageCount: messageCount,
      rolePolicy: messageCount
        ? 'PRIMARY_PLUS_FOUR_CONVERSATION_PASSES_PER_MESSAGE'
        : 'HYBRID_PRIMARY_LOCAL_PARSE_ONLY'
    },
    rawInvocationIds: rawInvocations.map((item) => item.rawInvocationId),
    rawInvocations,
    resultSummary: {
      businessType: 'order',
      operation: 'create_order',
      route: 'local',
      source: 'typed'
    },
    sequence: index,
    started: true,
    surface: 'FULL_PAGE'
  };
}

function pathContract(overrides = {}) {
  return Object.assign({
    actualPageMethod: 'pasteClipboard',
    directRawInvocationPolicy: 'FORBIDDEN',
    hybridInvocationPolicy: 'AT_LEAST_ONE',
    parserInvocationExpected: true,
    parserInvocationNotApplicable: false,
    productionPath: 'FULL_PAGE|CLIPBOARD_CHAT|pasteClipboard:HYBRID_INVOCATION',
    rawInvocationCardinality: 'DERIVED_FROM_HYBRID_INPUT_STRUCTURE',
    rawInvocationRolePolicy: 'PRIMARY_OR_CONVERSATION_REVIEW_ROLES',
    semanticResultSource: 'PAGE_CONFIRMED_DRAFT'
  }, overrides);
}

function makeGraph(hybrids) {
  const raws = hybrids.flatMap((item) => item.rawInvocations);
  return {
    collectionCompleted: true,
    directRawInvocations: [],
    hybridInvocations: hybrids,
    instrumentationInstalled: true,
    instrumentationInstalledBeforeAiParserLoad: true,
    orphanRawInvocations: [],
    rawInvocationCount: raws.length,
    shadowParserInvocations: [],
    status: raws.length ? 'RAW_PARSER_INVOKED' : 'RAW_PARSER_NOT_INVOKED_BY_PRODUCTION_PATH',
    uncorrelatedInvocationCount: 0,
    validationCompleted: false
  };
}

function validOne() {
  return validateParserInvocationGraph(makeGraph([makeHybrid(1)]), pathContract());
}

function validThirteen() {
  return validateParserInvocationGraph(makeGraph([makeHybrid(1, 3)]), pathContract());
}

function errorCodes(graph) {
  return (graph.errors || []).map((item) => item.code);
}

const tests = [
  {
    name: 'one-hybrid-one-raw-is-captured',
    async run() {
      const graph = validOne();
      assert.strictEqual(graph.status, 'RAW_PARSER_INVOKED');
      assert.strictEqual(graph.summary.rawInvocationCount, 1);
      assert.deepStrictEqual(graph.errors, []);
    }
  },
  {
    name: 'voice-hybrid-requires-completed-session-bound-evidence',
    async run() {
      const hybrid = makeHybrid(1);
      hybrid.voiceInputEvidence = {
        entrySurface: 'FULL_PAGE',
        inputChannel: 'VOICE_TRANSCRIPT',
        source: 'voice',
        present: true,
        status: 'COMPLETED',
        evidenceSource: 'FAKE_VOICE_FINAL_CALLBACK',
        fingerprint: 'voice-transcript-v1_example',
        fingerprintMatched: true,
        sessionId: 'voice-session-1',
        sequence: 4
      };
      hybrid.resultSummary = Object.assign({}, hybrid.resultSummary, {
        voiceCompletionEvidencePresent: true,
        voiceCompletionEvidenceSource: 'FAKE_VOICE_FINAL_CALLBACK',
        voiceCompletionEvidenceStatus: 'COMPLETED',
        voiceCompletionEvidenceValid: true
      });
      const graph = validateParserInvocationGraph(
        makeGraph([hybrid]),
        pathContract()
      );
      assert.deepStrictEqual(graph.errors, []);
      assert.strictEqual(graph.summary.voiceCompletionEvidenceCount, 1);
      assert.strictEqual(graph.summary.voiceEvidenceMissingCount, 0);
    }
  },
  {
    name: 'voice-route-trace-must-match-input-evidence',
    async run() {
      const hybrid = makeHybrid(1);
      hybrid.voiceInputEvidence = {
        inputChannel: 'VOICE_TRANSCRIPT',
        source: 'voice',
        present: true,
        status: 'COMPLETED',
        evidenceSource: 'FAKE_VOICE_FINAL_CALLBACK',
        fingerprint: 'voice-transcript-v1_example',
        fingerprintMatched: true,
        sessionId: 'voice-session-1',
        sequence: 4
      };
      const graph = validateParserInvocationGraph(
        makeGraph([hybrid]),
        pathContract()
      );
      assert(errorCodes(graph).includes('VOICE_COMPLETION_ROUTE_TRACE_MISMATCH'));
    }
  },
  {
    name: 'voice-hybrid-missing-or-mismatched-evidence-is-rejected',
    async run() {
      const missing = makeHybrid(1);
      missing.voiceInputEvidence = {
        inputChannel: 'VOICE_TRANSCRIPT',
        source: 'voice',
        present: false
      };
      const missingGraph = validateParserInvocationGraph(
        makeGraph([missing]),
        pathContract()
      );
      assert(errorCodes(missingGraph).includes('VOICE_COMPLETION_EVIDENCE_MISSING'));

      const mismatched = makeHybrid(1);
      mismatched.voiceInputEvidence = {
        inputChannel: 'VOICE_TRANSCRIPT',
        source: 'voice',
        present: true,
        status: 'COMPLETED',
        evidenceSource: 'FAKE_VOICE_FINAL_CALLBACK',
        fingerprint: 'wrong',
        fingerprintMatched: false,
        sessionId: 'voice-session-1',
        sequence: 4
      };
      const mismatchGraph = validateParserInvocationGraph(
        makeGraph([mismatched]),
        pathContract()
      );
      assert(errorCodes(mismatchGraph).includes(
        'VOICE_COMPLETION_FINGERPRINT_MISMATCH'
      ));
    }
  },
  {
    name: 'non-voice-hybrid-cannot-carry-final-voice-evidence',
    async run() {
      const hybrid = makeHybrid(1);
      hybrid.voiceInputEvidence = {
        inputChannel: 'MANUAL_TEXT',
        source: 'typed',
        present: true,
        status: 'COMPLETED',
        evidenceSource: 'FAKE_VOICE_FINAL_CALLBACK',
        fingerprint: 'forged',
        fingerprintMatched: true,
        sessionId: 'voice-session-1',
        sequence: 4
      };
      const graph = validateParserInvocationGraph(
        makeGraph([hybrid]),
        pathContract()
      );
      assert(errorCodes(graph).includes('NON_VOICE_COMPLETION_EVIDENCE_PRESENT'));
    }
  },
  {
    name: 'one-hybrid-thirteen-raw-is-captured',
    async run() {
      const graph = validThirteen();
      assert.strictEqual(graph.summary.rawInvocationCountsByHybrid[0].rawInvocationCount, 13);
      assert.deepStrictEqual(graph.errors, []);
    }
  },
  {
    name: 'two-hybrids-each-thirteen-raw-remain-separated',
    async run() {
      const graph = validateParserInvocationGraph(makeGraph([
        makeHybrid(1, 3, 'INITIAL_PARSE', 1),
        makeHybrid(2, 3, 'DEEP_REVIEW', 14)
      ]), pathContract());
      assert.deepStrictEqual(
        graph.summary.rawInvocationCountsByHybrid.map((item) => item.rawInvocationCount),
        [13, 13]
      );
      assert.strictEqual(graph.summary.rawInvocationCount, 26);
      assert.deepStrictEqual(graph.errors, []);
    }
  },
  {
    name: 'async-hybrids-do-not-cross-parent-contexts',
    async run() {
      const cursor = parserObservationCursor();
      const payloadA = { state: {}, text: '甲客户下单', reviewMode: 'deep' };
      const payloadB = { state: {}, text: '乙客户下单', reviewMode: 'standard' };
      await Promise.all([
        observeHybridInvocationForTest(payloadA, (parseInput) => new Promise((resolve) => {
          setTimeout(() => resolve(parseInput(payloadA)), 8);
        })),
        observeHybridInvocationForTest(payloadB, (parseInput) => new Promise((resolve) => {
          setTimeout(() => resolve(parseInput(payloadB)), 1);
        }))
      ]);
      const graph = collectParserObservationSince(cursor);
      assert.strictEqual(graph.hybridInvocations.length, 2);
      graph.hybridInvocations.forEach((hybrid) => {
        assert.strictEqual(hybrid.rawInvocations.length, 1);
        assert.strictEqual(
          hybrid.rawInvocations[0].parentHybridInvocationId,
          hybrid.hybridInvocationId
        );
      });
    }
  },
  {
    name: 'raw-failure-keeps-completed-evidence',
    async run() {
      const cursor = parserObservationCursor();
      assert.throws(
        () => observeRawInvocationForTest({ text: '故意失败' }, () => {
          throw Object.assign(new Error('sentinel raw failure'), { code: 'SENTINEL_RAW' });
        }),
        (error) => error.code === 'SENTINEL_RAW'
      );
      const graph = collectParserObservationSince(cursor);
      const validated = validateParserInvocationGraph(graph, pathContract({
        directRawInvocationPolicy: 'ALLOWED_REQUIRED',
        hybridInvocationPolicy: 'EXACTLY_ZERO'
      }));
      assert.strictEqual(validated.status, 'RAW_PARSER_INVOCATION_FAILED');
      assert.strictEqual(validated.directRawInvocations[0].rawInvocations[0].completed, true);
      assert.strictEqual(
        validated.directRawInvocations[0].rawInvocations[0].failure.code,
        'SENTINEL_RAW'
      );
    }
  },
  {
    name: 'later-raw-call-does-not-erase-earlier-evidence',
    async run() {
      const graph = validThirteen();
      assert.strictEqual(graph.hybridInvocations[0].rawInvocations[0].rawInvocationId, 'raw-1');
      assert.strictEqual(graph.hybridInvocations[0].rawInvocations[12].rawInvocationId, 'raw-13');
    }
  },
  {
    name: 'validation-failure-retains-complete-graph',
    async run() {
      const source = makeGraph([makeHybrid(1, 3)]);
      source.hybridInvocations[0].rawCardinalityExpectation.expectedCount = 12;
      const graph = validateParserInvocationGraph(source, pathContract());
      assert(errorCodes(graph).includes('HYBRID_RAW_CARDINALITY_MISMATCH'));
      assert.strictEqual(graph.hybridInvocations[0].rawInvocations.length, 13);
    }
  },
  {
    name: 'orphan-raw-is-rejected',
    async run() {
      const source = makeGraph([makeHybrid(1)]);
      const orphan = safeClone(source.hybridInvocations[0].rawInvocations[0]);
      orphan.rawInvocationId = 'raw-orphan';
      orphan.parentHybridInvocationId = null;
      source.orphanRawInvocations.push(orphan);
      source.rawInvocationCount += 1;
      source.uncorrelatedInvocationCount = 1;
      source.shadowParserInvocations.push(safeClone(orphan));
      const graph = validateParserInvocationGraph(source, pathContract());
      assert(errorCodes(graph).includes('UNPARENTED_OR_SHADOW_RAW_INVOCATION'));
    }
  },
  {
    name: 'raw-cannot-bind-to-hybrid-and-direct-parent',
    async run() {
      const source = makeGraph([makeHybrid(1)]);
      source.hybridInvocations[0].rawInvocations[0].parentDirectRawInvocationId = 'direct-1';
      const graph = validateParserInvocationGraph(source, pathContract());
      assert(errorCodes(graph).includes('RAW_HYBRID_PARENT_MISMATCH'));
    }
  },
  {
    name: 'duplicate-raw-invocation-id-is-rejected',
    async run() {
      const source = makeGraph([
        makeHybrid(1, 0, 'INITIAL_PARSE', 1),
        makeHybrid(2, 0, 'DEEP_REVIEW', 1)
      ]);
      const graph = validateParserInvocationGraph(source, pathContract());
      assert(errorCodes(graph).includes('DUPLICATE_RAW_INVOCATION_ID'));
    }
  },
  {
    name: 'raw-total-must-match-parent-child-sum',
    async run() {
      const source = makeGraph([makeHybrid(1)]);
      source.rawInvocationCount = 99;
      const graph = validateParserInvocationGraph(source, pathContract());
      assert(errorCodes(graph).includes('RAW_INVOCATION_TOTAL_MISMATCH'));
    }
  },
  {
    name: 'direct-raw-parent-does-not-need-hybrid',
    async run() {
      const directRaw = makeRaw('raw-1', null, 1, 'DIRECT_RAW_CONTRACT');
      directRaw.parentHybridInvocationId = null;
      directRaw.parentDirectRawInvocationId = 'direct-raw-parent-1';
      directRaw.sequenceInHybrid = null;
      directRaw.sequenceInDirectRaw = 1;
      const graph = validateParserInvocationGraph({
        collectionCompleted: true,
        directRawInvocations: [{
          completed: true,
          directRawInvocationId: 'direct-raw-parent-1',
          failure: null,
          label: 'DIRECT_RAW_INVOCATION',
          rawInvocationIds: ['raw-1'],
          rawInvocations: [directRaw],
          sequence: 1,
          started: true
        }],
        hybridInvocations: [],
        instrumentationInstalled: true,
        instrumentationInstalledBeforeAiParserLoad: true,
        orphanRawInvocations: [],
        rawInvocationCount: 1,
        shadowParserInvocations: [],
        uncorrelatedInvocationCount: 0
      }, pathContract({
        directRawInvocationPolicy: 'ALLOWED_REQUIRED',
        hybridInvocationPolicy: 'EXACTLY_ZERO'
      }));
      assert.strictEqual(graph.status, 'RAW_PARSER_INVOKED');
      assert.deepStrictEqual(graph.errors, []);
    }
  },
  {
    name: 'direct-raw-parent-is-forbidden-on-user-production-path',
    async run() {
      const directRaw = makeRaw('raw-1', null, 1, 'DIRECT_RAW_CONTRACT');
      directRaw.parentHybridInvocationId = null;
      directRaw.parentDirectRawInvocationId = 'direct-raw-parent-1';
      directRaw.sequenceInHybrid = null;
      directRaw.sequenceInDirectRaw = 1;
      const graph = validateParserInvocationGraph({
        collectionCompleted: true,
        directRawInvocations: [{
          completed: true,
          directRawInvocationId: 'direct-raw-parent-1',
          failure: null,
          label: 'DIRECT_RAW_INVOCATION',
          rawInvocationIds: ['raw-1'],
          rawInvocations: [directRaw],
          sequence: 1,
          started: true
        }],
        hybridInvocations: [],
        instrumentationInstalled: true,
        instrumentationInstalledBeforeAiParserLoad: true,
        orphanRawInvocations: [],
        rawInvocationCount: 1,
        shadowParserInvocations: [],
        uncorrelatedInvocationCount: 0
      }, pathContract({ hybridInvocationPolicy: 'EXACTLY_ZERO' }));
      assert(errorCodes(graph).includes(
        'DIRECT_RAW_INVOCATION_FORBIDDEN_ON_PRODUCTION_PATH'
      ));
    }
  },
  {
    name: 'unresolved-zero-invocation-page-path-is-rejected',
    async run() {
      const graph = validateParserInvocationGraph(
        makeGraph([]),
        pathContract({
          hybridInvocationPolicy: 'AT_LEAST_ONE_OR_NO_BUSINESS_CONFIRMATION',
          parserInvocationExpected: false,
          parserInvocationNotApplicable: false,
          productionBranch: 'UNRESOLVED_ZERO_INVOCATION',
          zeroInvocationResolved: false
        })
      );
      assert(errorCodes(graph).includes('UNRESOLVED_ZERO_PARSER_INVOCATION'));
      assert(errorCodes(graph).includes('ZERO_PARSER_INVOCATION_PATH_UNPROVEN'));
      assert.strictEqual(graph.status, 'RAW_PARSER_EVIDENCE_MISSING');
    }
  },
  {
    name: 'shadow-raw-is-a-hard-error',
    async run() {
      const source = makeGraph([makeHybrid(1)]);
      source.shadowParserInvocations = [safeClone(
        source.hybridInvocations[0].rawInvocations[0]
      )];
      const graph = validateParserInvocationGraph(source, pathContract());
      assert(errorCodes(graph).includes('UNPARENTED_OR_SHADOW_RAW_INVOCATION'));
    }
  },
  {
    name: 'late-instrumentation-is-a-hard-error',
    async run() {
      const source = makeGraph([makeHybrid(1)]);
      source.instrumentationInstalledBeforeAiParserLoad = false;
      const graph = validateParserInvocationGraph(source, pathContract());
      assert(errorCodes(graph).includes('PARSER_INSTRUMENTATION_NOT_INSTALLED_BEFORE_LOAD'));
    }
  },
  {
    name: 'early-collector-exit-is-evidence-missing',
    async run() {
      const source = makeGraph([makeHybrid(1)]);
      source.collectionCompleted = false;
      const graph = validateParserInvocationGraph(source, pathContract());
      assert.strictEqual(graph.status, 'RAW_PARSER_EVIDENCE_MISSING');
      assert(errorCodes(graph).includes('PARSER_INVOCATION_COLLECTION_INCOMPLETE'));
    }
  },
  {
    name: 'multi-call-graph-is-not-compressed-to-primary-result',
    async run() {
      const graph = validThirteen();
      assert.strictEqual(Object.prototype.hasOwnProperty.call(graph, 'result'), false);
      assert.strictEqual(graph.hybridInvocations[0].rawInvocations.length, 13);
    }
  },
  {
    name: 'semantic-result-is-independent-from-raw-graph',
    async run() {
      const graph = validOne();
      graph.summary.canonicalLocalResults[0].resultSummary.businessType = 'quotation';
      const semantic = canonicalSemanticResult({
        businessType: 'order',
        operation: 'create_order'
      });
      assert.strictEqual(semantic.businessType, 'order');
      assert.strictEqual(semantic.effectiveOperation, 'create_order');
    }
  },
  {
    name: 'phase-comes-from-review-mode-not-call-sequence',
    async run() {
      const cursor = parserObservationCursor();
      const deep = { state: {}, text: '深度核对', reviewMode: 'deep' };
      const standard = { state: {}, text: '普通核对', reviewMode: 'standard' };
      await observeHybridInvocationForTest(deep, (parseInput) => parseInput(deep));
      await observeHybridInvocationForTest(standard, (parseInput) => parseInput(standard));
      const graph = collectParserObservationSince(cursor);
      assert.deepStrictEqual(
        graph.hybridInvocations.map((item) => item.phase),
        ['DEEP_REVIEW', 'INITIAL_PARSE']
      );
    }
  },
  {
    name: 'multi-009-real-production-graph-is-two-by-thirteen',
    async run() {
      const suite = await runSuite({ caseId: 'REC-E2E-MULTI-009' });
      const result = suite.attempts[0].results[0];
      const graph = result.parserObservation;
      assert.notStrictEqual(result.caseStatus, 'RUNNER_ERROR');
      assert.strictEqual(graph.status, 'RAW_PARSER_INVOKED');
      assert.strictEqual(graph.summary.hybridInvocationCount, 2);
      assert.deepStrictEqual(
        graph.summary.rawInvocationCountsByHybrid.map((item) => item.rawInvocationCount),
        [13, 13]
      );
      assert.deepStrictEqual(
        graph.hybridInvocations.map((item) => item.phase),
        ['INITIAL_PARSE', 'DEEP_REVIEW']
      );
      assert.strictEqual(graph.orphanRawInvocations.length, 0);
      assert.strictEqual(graph.shadowParserInvocations.length, 0);
      assert.strictEqual(graph.uncorrelatedInvocationCount, 0);
      assert.strictEqual(result.isolationAuditCompletion.workerCleanupCompleted, true);
    }
  }
];

(async () => {
  loadObservedAiParser();
  let passed = 0;
  for (const test of tests) {
    try {
      await test.run();
      passed += 1;
      console.log(`PASS ${test.name}`);
    } catch (error) {
      console.error(`FAIL ${test.name}: ${error.message}`);
    }
  }
  console.log(`Parser invocation graph tests: ${passed}/${tests.length} passed`);
  if (passed !== tests.length) process.exitCode = 1;
})();
