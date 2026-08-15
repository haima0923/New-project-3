const { safeClone, stableHash } = require('../../../utils/record-state-diff');

const RAW_PARSER_STATUSES = Object.freeze({
  INVOCATION_FAILED: 'RAW_PARSER_INVOCATION_FAILED',
  INVOKED: 'RAW_PARSER_INVOKED',
  EVIDENCE_MISSING: 'RAW_PARSER_EVIDENCE_MISSING',
  NOT_INVOKED: 'RAW_PARSER_NOT_INVOKED_BY_PRODUCTION_PATH'
});

const CONVERSATION_ROLES = Object.freeze([
  'CONVERSATION_CONFLICT_UNIT_PRICE_SCAN',
  'CONVERSATION_CONFLICT_QUANTITY_SCAN',
  'CONVERSATION_LATEST_UNIT_PRICE_SCAN',
  'CONVERSATION_LATEST_QUANTITY_SCAN'
]);

const SOURCE_ITEM_ROLES = Object.freeze([
  'SOURCE_ITEM_DRAFT_SCAN',
  'SOURCE_ITEM_FACT_GATE_SCAN',
  'SOURCE_ITEM_ROUTE_GATE_SCAN'
]);

function countBy(values, read) {
  return values.reduce((output, value) => {
    const key = read(value);
    output[key] = (output[key] || 0) + 1;
    return output;
  }, {});
}

function duplicateValues(values) {
  return Array.from(new Set(
    values.filter((value, index) => values.indexOf(value) !== index)
  )).sort();
}

function push(errors, code, detail = {}) {
  errors.push({ code, detail });
}

function validateHybridCardinality(hybrid, errors) {
  const raw = hybrid.rawInvocations || [];
  const expected = hybrid.rawCardinalityExpectation || {};
  const roleCounts = countBy(raw, (item) => item.role);
  const primaryFullInputCount = raw.filter((item) => (
    item.role === 'HYBRID_PRIMARY_LOCAL_PARSE'
    && item.inputKind === 'HYBRID_FULL_INPUT'
  )).length;
  if (primaryFullInputCount !== 1) {
    push(errors, 'HYBRID_PRIMARY_RAW_ROLE_MISSING', {
      hybridInvocationId: hybrid.hybridInvocationId,
      primaryFullInputCount,
      roleCounts
    });
  }
  const allowed = new Set(
    ['HYBRID_PRIMARY_LOCAL_PARSE'].concat(CONVERSATION_ROLES, SOURCE_ITEM_ROLES)
  );
  raw.filter((item) => !allowed.has(item.role)).forEach((item) => {
    push(errors, 'HYBRID_RAW_ROLE_UNCLASSIFIED', {
      hybridInvocationId: hybrid.hybridInvocationId,
      rawInvocationId: item.rawInvocationId,
      role: item.role
    });
  });
  const fingerprintsForRole = (role) => raw
    .filter((item) => item.role === role)
    .map((item) => item.inputFingerprint)
    .sort();
  const sourceDraft = fingerprintsForRole('SOURCE_ITEM_DRAFT_SCAN');
  const sourceFact = fingerprintsForRole('SOURCE_ITEM_FACT_GATE_SCAN');
  const sourceRoute = fingerprintsForRole('SOURCE_ITEM_ROUTE_GATE_SCAN');
  if (sourceDraft.length || sourceFact.length || sourceRoute.length) {
    const factFingerprint = JSON.stringify(sourceFact);
    const routeFingerprint = JSON.stringify(sourceRoute);
    const draftFingerprint = JSON.stringify(sourceDraft);
    if (factFingerprint !== routeFingerprint
      || (sourceDraft.length > 0 && draftFingerprint !== factFingerprint)) {
      push(errors, 'SOURCE_ITEM_SCAN_FINGERPRINT_MISMATCH', {
        hybridInvocationId: hybrid.hybridInvocationId,
        sourceDraft,
        sourceFact,
        sourceRoute
      });
    }
  }
  if (expected.policy === 'EXACTLY_ONE') {
    return;
  }
  if (expected.policy === 'DERIVED_FROM_INPUT_STRUCTURE') {
    const messageCount = Number(expected.rawMessageCount || 0);
    CONVERSATION_ROLES.forEach((role) => {
      if (Number(roleCounts[role] || 0) !== messageCount) {
        push(errors, 'HYBRID_CONVERSATION_RAW_ROLE_COUNT_MISMATCH', {
          actual: Number(roleCounts[role] || 0),
          expected: messageCount,
          hybridInvocationId: hybrid.hybridInvocationId,
          role
        });
      }
    });
  }
}

function validateVoiceCompletionPropagation(hybrid, errors) {
  const evidence = hybrid.voiceInputEvidence || {};
  const result = hybrid.resultSummary || {};
  const isVoice = evidence.source === 'voice'
    || evidence.inputChannel === 'VOICE_TRANSCRIPT';
  if (!isVoice) {
    if (evidence.present === true) {
      push(errors, 'NON_VOICE_COMPLETION_EVIDENCE_PRESENT', {
        hybridInvocationId: hybrid.hybridInvocationId,
        inputChannel: evidence.inputChannel,
        source: evidence.source
      });
    }
    if (result.voiceCompletionEvidencePresent === true
      || result.voiceCompletionEvidenceValid === true
      || result.voiceCompletionEvidenceStatus
      || result.voiceCompletionEvidenceSource) {
      push(errors, 'NON_VOICE_ROUTE_TRACE_EVIDENCE_PRESENT', {
        hybridInvocationId: hybrid.hybridInvocationId
      });
    }
    return;
  }
  if (evidence.present !== true) {
    push(errors, 'VOICE_COMPLETION_EVIDENCE_MISSING', {
      hybridInvocationId: hybrid.hybridInvocationId,
      phase: hybrid.phase,
      surface: hybrid.surface
    });
    return;
  }
  if (evidence.status !== 'COMPLETED') {
    push(errors, 'VOICE_COMPLETION_STATUS_INVALID', {
      hybridInvocationId: hybrid.hybridInvocationId,
      status: evidence.status
    });
  }
  if (!['VOICE_PROVIDER_FINAL_CALLBACK', 'FAKE_VOICE_FINAL_CALLBACK'].includes(
    evidence.evidenceSource
  )) {
    push(errors, 'VOICE_COMPLETION_SOURCE_INVALID', {
      evidenceSource: evidence.evidenceSource,
      hybridInvocationId: hybrid.hybridInvocationId
    });
  }
  if (!evidence.sessionId || !evidence.fingerprint || Number(evidence.sequence) < 1) {
    push(errors, 'VOICE_COMPLETION_BINDING_INCOMPLETE', {
      hybridInvocationId: hybrid.hybridInvocationId
    });
  }
  if (evidence.fingerprintMatched !== true) {
    push(errors, 'VOICE_COMPLETION_FINGERPRINT_MISMATCH', {
      hybridInvocationId: hybrid.hybridInvocationId
    });
  }
  if (result.voiceCompletionEvidencePresent !== true
    || result.voiceCompletionEvidenceValid !== true
    || result.voiceCompletionEvidenceStatus !== evidence.status
    || result.voiceCompletionEvidenceSource !== evidence.evidenceSource) {
    push(errors, 'VOICE_COMPLETION_ROUTE_TRACE_MISMATCH', {
      hybridInvocationId: hybrid.hybridInvocationId,
      inputEvidence: {
        evidenceSource: evidence.evidenceSource,
        present: evidence.present,
        status: evidence.status
      },
      resultEvidence: {
        evidenceSource: result.voiceCompletionEvidenceSource,
        present: result.voiceCompletionEvidencePresent,
        status: result.voiceCompletionEvidenceStatus,
        valid: result.voiceCompletionEvidenceValid
      }
    });
  }
}

function validateParserInvocationGraph(observation, productionPath) {
  const graph = safeClone(observation || {});
  const errors = [];
  const contractFindings = [];
  const hybrids = graph.hybridInvocations || [];
  const directs = graph.directRawInvocations || [];
  const raw = hybrids.flatMap((item) => item.rawInvocations || [])
    .concat(directs.flatMap((item) => item.rawInvocations || []))
    .concat(graph.orphanRawInvocations || []);
  if (graph.instrumentationInstalled !== true
    || graph.instrumentationInstalledBeforeAiParserLoad !== true) {
    push(errors, 'PARSER_INSTRUMENTATION_NOT_INSTALLED_BEFORE_LOAD');
  }
  if (graph.collectionCompleted !== true) {
    push(errors, 'PARSER_INVOCATION_COLLECTION_INCOMPLETE');
  }
  if (!productionPath || !productionPath.productionPath) {
    push(errors, 'PARSER_PRODUCTION_PATH_EVIDENCE_MISSING');
  }
  const hybridIds = hybrids.map((item) => item.hybridInvocationId);
  const directIds = directs.map((item) => item.directRawInvocationId);
  const rawIds = raw.map((item) => item.rawInvocationId);
  duplicateValues(hybridIds).forEach((id) => push(
    errors,
    'DUPLICATE_HYBRID_INVOCATION_ID',
    { id }
  ));
  duplicateValues(directIds).forEach((id) => push(
    errors,
    'DUPLICATE_DIRECT_RAW_PARENT_ID',
    { id }
  ));
  duplicateValues(rawIds).forEach((id) => push(
    errors,
    'DUPLICATE_RAW_INVOCATION_ID',
    { id }
  ));
  hybrids.forEach((hybrid) => {
    if (hybrid.started !== true || hybrid.completed !== true) {
      push(errors, 'HYBRID_INVOCATION_INCOMPLETE', {
        hybridInvocationId: hybrid.hybridInvocationId
      });
    }
    if (!['INITIAL_PARSE', 'DEEP_REVIEW'].includes(hybrid.phase)) {
      push(errors, 'HYBRID_PHASE_NOT_FROM_PRODUCTION_CONTEXT', {
        hybridInvocationId: hybrid.hybridInvocationId,
        phase: hybrid.phase
      });
    }
    if (!hybrid.inputFingerprint || !hybrid.callerAction) {
      push(errors, 'HYBRID_INVOCATION_EVIDENCE_MISSING', {
        hybridInvocationId: hybrid.hybridInvocationId
      });
    }
    (hybrid.rawInvocations || []).forEach((item, index) => {
      if (item.parentHybridInvocationId !== hybrid.hybridInvocationId
        || item.parentDirectRawInvocationId !== null) {
        push(errors, 'RAW_HYBRID_PARENT_MISMATCH', {
          hybridInvocationId: hybrid.hybridInvocationId,
          rawInvocationId: item.rawInvocationId
        });
      }
      if (Number(item.sequenceInHybrid) !== index + 1) {
        push(errors, 'RAW_HYBRID_SEQUENCE_MISMATCH', {
          hybridInvocationId: hybrid.hybridInvocationId,
          rawInvocationId: item.rawInvocationId
        });
      }
    });
    validateHybridCardinality(hybrid, errors);
    // Voice completion propagation is a production boundary contract. A
    // missing/mismatched token must fail the case, but it must not be reported
    // as missing runner instrumentation.
    validateVoiceCompletionPropagation(hybrid, contractFindings);
  });
  directs.forEach((direct) => {
    if (direct.started !== true || direct.completed !== true) {
      push(errors, 'DIRECT_RAW_INVOCATION_INCOMPLETE', {
        directRawInvocationId: direct.directRawInvocationId
      });
    }
    if (!(direct.rawInvocations || []).length) {
      push(errors, 'DIRECT_RAW_INVOCATION_EMPTY', {
        directRawInvocationId: direct.directRawInvocationId
      });
    }
    (direct.rawInvocations || []).forEach((item, index) => {
      if (item.parentDirectRawInvocationId !== direct.directRawInvocationId
        || item.parentHybridInvocationId !== null) {
        push(errors, 'RAW_DIRECT_PARENT_MISMATCH', {
          directRawInvocationId: direct.directRawInvocationId,
          rawInvocationId: item.rawInvocationId
        });
      }
      if (Number(item.sequenceInDirectRaw) !== index + 1) {
        push(errors, 'RAW_DIRECT_SEQUENCE_MISMATCH', {
          directRawInvocationId: direct.directRawInvocationId,
          rawInvocationId: item.rawInvocationId
        });
      }
    });
  });
  raw.forEach((item) => {
    const parentCount = Number(Boolean(item.parentHybridInvocationId))
      + Number(Boolean(item.parentDirectRawInvocationId));
    if (parentCount !== 1) {
      push(errors, 'ORPHAN_OR_MULTIPLE_PARENT_RAW_INVOCATION', {
        rawInvocationId: item.rawInvocationId
      });
    }
    if (item.started !== true || item.completed !== true
      || !item.inputFingerprint || !item.calledFunction) {
      push(errors, 'RAW_INVOCATION_EVIDENCE_INCOMPLETE', {
        rawInvocationId: item.rawInvocationId
      });
    }
  });
  if (raw.length !== Number(graph.rawInvocationCount || 0)) {
    push(errors, 'RAW_INVOCATION_TOTAL_MISMATCH', {
      actualGraphCount: raw.length,
      recordedTotal: graph.rawInvocationCount
    });
  }
  if ((graph.orphanRawInvocations || []).length
    || Number(graph.uncorrelatedInvocationCount || 0)
    || (graph.shadowParserInvocations || []).length) {
    push(errors, 'UNPARENTED_OR_SHADOW_RAW_INVOCATION', {
      orphanCount: (graph.orphanRawInvocations || []).length,
      shadowCount: (graph.shadowParserInvocations || []).length,
      uncorrelatedInvocationCount: graph.uncorrelatedInvocationCount
    });
  }
  if (productionPath) {
    if (productionPath.directRawInvocationPolicy !== 'ALLOWED_REQUIRED'
      && directs.length !== 0) {
      push(errors, 'DIRECT_RAW_INVOCATION_FORBIDDEN_ON_PRODUCTION_PATH', {
        directRawInvocationCount: directs.length,
        productionPath: productionPath.productionPath
      });
    }
    if (productionPath.directRawInvocationPolicy === 'ALLOWED_REQUIRED'
      && directs.length < 1) {
      push(errors, 'REQUIRED_DIRECT_RAW_INVOCATION_MISSING');
    }
    if (productionPath.hybridInvocationPolicy === 'AT_LEAST_ONE'
      && hybrids.length < 1) {
      push(errors, 'REQUIRED_HYBRID_INVOCATION_MISSING');
    }
    if (productionPath.hybridInvocationPolicy === 'EXACTLY_ZERO'
      && hybrids.length !== 0) {
      push(errors, 'UNEXPECTED_HYBRID_INVOCATION');
    }
    if (productionPath.hybridInvocationPolicy === 'AT_LEAST_ONE_OR_NO_BUSINESS_CONFIRMATION'
      && hybrids.length === 0
      && productionPath.parserInvocationNotApplicable !== true) {
      push(errors, 'UNRESOLVED_ZERO_PARSER_INVOCATION', {
        productionBranch: productionPath.productionBranch
      });
    }
    if (raw.length === 0
      && productionPath.zeroInvocationResolved !== true) {
      push(errors, 'ZERO_PARSER_INVOCATION_PATH_UNPROVEN', {
        productionBranch: productionPath.productionBranch
      });
    }
    if (productionPath.parserInvocationExpected === true && raw.length < 1) {
      push(errors, 'REQUIRED_RAW_PARSER_INVOCATION_MISSING');
    }
    if (productionPath.parserInvocationNotApplicable === true && raw.length !== 0) {
      push(errors, 'NOT_APPLICABLE_RAW_PARSER_WAS_INVOKED');
    }
  }
  const rawFailures = raw.filter((item) => item.failure);
  let status;
  if (errors.length) status = RAW_PARSER_STATUSES.EVIDENCE_MISSING;
  else if (rawFailures.length) status = RAW_PARSER_STATUSES.INVOCATION_FAILED;
  else if (raw.length) status = RAW_PARSER_STATUSES.INVOKED;
  else status = RAW_PARSER_STATUSES.NOT_INVOKED;
  const canonicalLocalResults = hybrids.map((hybrid) => {
    const primary = (hybrid.rawInvocations || []).find(
      (item) => item.role === 'HYBRID_PRIMARY_LOCAL_PARSE'
    );
    return {
      hybridInvocationId: hybrid.hybridInvocationId,
      phase: hybrid.phase,
      rawInvocationId: primary && primary.rawInvocationId || null,
      resultSummary: primary && safeClone(primary.resultSummary) || null
    };
  });
  const summary = {
    canonicalLocalResults,
    directRawResults: directs.flatMap((direct) => (
      (direct.rawInvocations || []).map((item) => ({
        directRawInvocationId: direct.directRawInvocationId,
        rawInvocationId: item.rawInvocationId,
        resultSummary: safeClone(item.resultSummary)
      }))
    )),
    directRawInvocationCount: directs.length,
    hybridInvocationCount: hybrids.length,
    rawInvocationCount: raw.length,
    rawInvocationCountsByHybrid: hybrids.map((item) => ({
      hybridInvocationId: item.hybridInvocationId,
      phase: item.phase,
      rawInvocationCount: (item.rawInvocations || []).length
    })),
    rawRoleCounts: countBy(raw, (item) => item.role),
    rawFailureCount: rawFailures.length,
    voiceCompletionEvidenceCount: hybrids.filter((hybrid) => (
      hybrid.voiceInputEvidence
      && hybrid.voiceInputEvidence.present === true
    )).length,
    voiceFingerprintMismatchCount: hybrids.filter((hybrid) => (
      hybrid.voiceInputEvidence
      && hybrid.voiceInputEvidence.present === true
      && hybrid.voiceInputEvidence.fingerprintMatched !== true
    )).length,
    voiceEvidenceMissingCount: hybrids.filter((hybrid) => {
      const evidence = hybrid.voiceInputEvidence || {};
      const isVoice = evidence.source === 'voice'
        || evidence.inputChannel === 'VOICE_TRANSCRIPT';
      return isVoice && evidence.present !== true;
    }).length
  };
  const validated = Object.assign(graph, {
    contractFindings,
    errors,
    graphFingerprint: stableHash({
      directs,
      hybrids,
      rawSequence: raw.map((item) => ({
        inputFingerprint: item.inputFingerprint,
        parentDirectRawInvocationId: item.parentDirectRawInvocationId,
        parentHybridInvocationId: item.parentHybridInvocationId,
        role: item.role,
        sequenceInHybrid: item.sequenceInHybrid
      }))
    }, 'parser-invocation-graph-v1'),
    productionPath: safeClone(productionPath),
    status,
    summary,
    validationCompleted: true
  });
  return validated;
}

function graphErrors(observation) {
  if (!observation || observation.validationCompleted !== true) {
    return [{ code: 'PARSER_INVOCATION_GRAPH_NOT_VALIDATED' }];
  }
  return safeClone(observation.errors || []);
}

module.exports = {
  CONVERSATION_ROLES,
  SOURCE_ITEM_ROLES,
  RAW_PARSER_STATUSES,
  graphErrors,
  validateParserInvocationGraph
};
