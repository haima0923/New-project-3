const { safeClone, stableHash } = require('../../../utils/record-state-diff');
const { createTranscriptFingerprint } = require('../../../utils/voice-recognition');
const { answerQuestion, inputEvent, questionState } = require('../record-confirm-interaction-v1/page-actions');
const {
  collectParserObservationSince,
  parserObservationCursor
} = require('../runner/observed-ai-parser');
const {
  FORBIDDEN_HANDOFF_KEYS,
  MISSING_PRODUCT_TEXT,
  MULTI_ITEM_TEXT,
  NEW_TEXT_B,
  PASTE_ORDER_TEXT,
  SIMPLE_ORDER_TEXT,
  STALE_TEXT_A,
  VOICE_ORDER_TEXT
} = require('./fixtures');
const {
  allZero,
  createEntryHarness,
  dashboardAuthorityEvidence,
  diffCounts,
  extractDashboardBindings,
  inputAuthorityEvidence,
  invokeDashboardSource,
  runDirectInput,
  semanticProjection,
  settlePage,
  stateCounts,
  storageTransferWrites
} = require('./runtime');

function check(code, pass, expected, actual, evidenceLayer = 'PAGE_VM') {
  return { actual: safeClone(actual), code, evidenceLayer, expected: safeClone(expected), pass: Boolean(pass) };
}

function businessCallsZero(authority = {}) {
  const business = authority.business || {};
  return Number(business.saveConfirmedDraft || 0) === 0
    && Number(business.savePendingNote || 0) === 0
    && Number(business.convertQuotationToOrder || 0) === 0
    && Number(authority.storageSaveCalls || 0) === 0;
}

function stateMutationEvidence(harness) {
  const state = harness.readState();
  const after = stateCounts(state);
  const delta = diffCounts(harness.stateBefore, after);
  const beforeHash = stableHash(harness.stateSnapshotBefore || {}, 'entry-business-state');
  const afterHash = stableHash(state || {}, 'entry-business-state');
  return { after, afterHash, beforeHash, delta, zero: allZero(delta) && beforeHash === afterHash };
}

function networkEvidence(harness) {
  const events = harness.network.aiEvents();
  return {
    count: events.length,
    paths: events.map((entry) => entry.path),
    settled: events.every((entry) => entry.settled === true),
    unsettled: harness.network.audit().unsettledRequestCount
  };
}

function handoffPayload(audit = {}) {
  const call = (audit.publishCalls || [])[0];
  if (!call) return null;
  const args = Array.isArray(call.args) ? call.args : [];
  return args.find((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)) || null;
}

function phaseOf(page) {
  return String(page && page.data && page.data.conversationPhase || '');
}

function inputSnapshot(harness) {
  const page = harness.input.page;
  const question = questionState(page);
  const result = page.data.parseResult || {};
  const securityState = {
    activeQuestion: safeClone(page.data.activeQuestion || null),
    assistantQuestionState: String(page.data.assistantQuestionState || ''),
    assistantQuestions: safeClone(page.data.assistantQuestions || []),
    clientConfirmationContext: safeClone(result.client_confirmation_context || null),
    confirmationSessionId: String(page.confirmationSessionId || ''),
    conversationPhase: String(page.data.conversationPhase || ''),
    currentRequestedRoute: String(page.currentRequestedRoute || ''),
    disableFormalSave: Boolean(page.data.disableFormalSave),
    draftRevision: String(page.draftRevision || ''),
    fields: safeClone(page.data.fields || result.fields || {}),
    originalText: String(result.original_text || result.originalText || ''),
    parseResult: safeClone(result),
    parsing: Boolean(page.data.parsing),
    showFormalSaveButton: Boolean(page.data.showFormalSaveButton),
    showPendingButton: Boolean(page.data.showPendingButton),
    source: String(page.data.source || result.source || ''),
    text: String(page.data.text || '')
  };
  return {
    activeQuestionTarget: String(question.question && question.question.target
      && question.question.target.field || ''),
    originalText: String(page.data.parseResult && (
      page.data.parseResult.original_text || page.data.parseResult.originalText
    ) || page.data.text || ''),
    phase: phaseOf(page),
    resultSource: String(result.source || ''),
    route: String((semanticProjection(page) || {}).route || ''),
    runParseCalls: Number(harness.input.evidence.pageMethodCalls.runParse || 0),
    securityHash: stableHash(securityState, 'entry-input-security-state'),
    semantic: semanticProjection(page),
    session: String(page.confirmationSessionId || ''),
    source: String(page.data.source || result.source || ''),
    text: String(page.data.text || '')
  };
}

async function withHarness(options, execute) {
  const harness = createEntryHarness(options);
  try {
    return await execute(harness);
  } finally {
    const unsettled = harness.network.audit().unsettledRequestCount;
    harness.dispose();
    if (unsettled !== 0) {
      const error = new Error(`Entry harness leaked ${unsettled} controlled request(s)`);
      error.code = 'HARNESS_UNSETTLED_REQUESTS';
      throw error;
    }
  }
}

async function entryProbe(source, text, options = {}) {
  return withHarness(Object.assign({}, options, {
    caseId: options.caseId || `ENTRY-${source}`,
    clipboardText: source === 'paste' ? text : options.clipboardText
  }), async (harness) => {
    const action = await invokeDashboardSource(harness, source, text);
    const dashboardNetwork = networkEvidence(harness);
    const navigationBeforeFollow = harness.navigation.audit();
    const inputParserCursor = parserObservationCursor();
    const follow = await harness.followInputNavigation();
    await settlePage(harness.input.page);
    const inputParserObservation = collectParserObservationSince(inputParserCursor);
    return {
      action,
      dashboard: dashboardAuthorityEvidence(harness),
      dashboardNetwork,
      follow,
      handoff: harness.handoffObserver.audit(),
      input: inputAuthorityEvidence(harness),
      inputParser: {
        hybridInvocationCount: inputParserObservation.hybridInvocations.length,
        sources: inputParserObservation.hybridInvocations.map((entry) => (
          entry.voiceInputEvidence && entry.voiceInputEvidence.source || entry.resultSummary && entry.resultSummary.source || ''
        )),
        surfaces: inputParserObservation.hybridInvocations.map((entry) => entry.surface || '')
      },
      inputSnapshot: inputSnapshot(harness),
      mutation: stateMutationEvidence(harness),
      navigation: navigationBeforeFollow,
      network: networkEvidence(harness),
      storageTransfers: storageTransferWrites(harness)
    };
  });
}

function standardHandoffChecks(prefix, probe, source, text) {
  const payload = handoffPayload(probe.handoff);
  const inputNavigations = probe.navigation.filter((entry) => entry.url.startsWith('/pages/input/input'));
  return [
    check(`${prefix}.DASHBOARD_ACTION_BOUND`, probe.action.invoked, true, probe.action.bindings, 'STATIC_SOURCE'),
    check(`${prefix}.DASHBOARD_PARSE_ZERO`, probe.dashboard.quickParseCalls === 0, 0, probe.dashboard.quickParseCalls),
    check(`${prefix}.DASHBOARD_PARSER_ROOT_ZERO`, probe.action.parserObservation.hybridInvocationCount === 0
      && probe.action.parserObservation.rawInvocationCount === 0,
      0, probe.action.parserObservation),
    check(`${prefix}.DASHBOARD_AI_ZERO`, probe.dashboardNetwork.count === 0, 0, probe.dashboardNetwork),
    check(`${prefix}.DASHBOARD_MODAL_UNREACHABLE`, !probe.dashboard.hasOldModalState, false, probe.dashboard.hasOldModalState),
    check(`${prefix}.DASHBOARD_SAVE_ZERO`, businessCallsZero(probe.dashboard)
      && probe.dashboard.formalCalls === 0 && probe.dashboard.pendingCalls === 0, 0, probe.dashboard),
    check(`${prefix}.DASHBOARD_DEEP_ZERO`, probe.dashboard.deepCalls === 0, 0, probe.dashboard.deepCalls),
    check(`${prefix}.NAVIGATES_ONCE`, inputNavigations.length === 1
      && inputNavigations[0].url === '/pages/input/input',
    [{ type: 'SWITCH_TAB', url: '/pages/input/input' }], inputNavigations),
    check(`${prefix}.HANDOFF_PUBLISHED_ONCE`, probe.handoff.publishCalls.length === 1, 1, probe.handoff),
    check(`${prefix}.HANDOFF_TEXT`, Boolean(payload) && String(payload.originalText || '') === text,
      text, payload && payload.originalText),
    check(`${prefix}.HANDOFF_SOURCE`, Boolean(payload) && String(payload.source || '') === source,
      source, payload && payload.source),
    check(`${prefix}.INPUT_AUTOPARSE_ONCE`, probe.input.runParseCalls === 1, 1, probe.input.runParseCalls),
    check(`${prefix}.INPUT_SOURCE_CONSUMED`, probe.inputSnapshot.source === source
      && probe.inputSnapshot.resultSource === source, source, {
        dataSource: probe.inputSnapshot.source,
        resultSource: probe.inputSnapshot.resultSource
      }),
    check(`${prefix}.INPUT_PARSER_SOURCE`, probe.inputParser.hybridInvocationCount === 1
      && probe.inputParser.sources.every((value) => value === source)
      && probe.inputParser.surfaces.every((value) => value === 'FULL_PAGE'),
    { source, surface: 'FULL_PAGE' }, probe.inputParser),
    check(`${prefix}.NO_BUSINESS_STORAGE_TRANSFER`, probe.storageTransfers.length === 0, [], probe.storageTransfers),
    check(`${prefix}.NO_MUTATION`, probe.mutation.zero && businessCallsZero(probe.input), true, {
      input: probe.input, mutation: probe.mutation
    })
  ];
}

async function entry001() {
  const probe = await entryProbe('typed', MISSING_PRODUCT_TEXT, { caseId: 'ENTRY-001' });
  return [
    ...standardHandoffChecks('ENTRY001', probe, 'typed', MISSING_PRODUCT_TEXT),
    check('ENTRY001.CLARIFYING', probe.inputSnapshot.phase === 'CLARIFYING', 'CLARIFYING', probe.inputSnapshot.phase),
    check('ENTRY001.PRODUCT_TARGET', probe.inputSnapshot.activeQuestionTarget === 'productName',
      'productName', probe.inputSnapshot.activeQuestionTarget)
  ];
}

async function entry002() {
  const probe = await entryProbe('paste', PASTE_ORDER_TEXT, { caseId: 'ENTRY-002' });
  const direct = await runDirectInput(PASTE_ORDER_TEXT, { caseId: 'ENTRY-002-DIRECT', source: 'paste' });
  try {
    const directSemantic = semanticProjection(direct.input.page);
    return [
      ...standardHandoffChecks('ENTRY002', probe, 'paste', PASTE_ORDER_TEXT),
      check('ENTRY002.RAW_TEXT_EXACT', probe.inputSnapshot.originalText === PASTE_ORDER_TEXT,
        PASTE_ORDER_TEXT, probe.inputSnapshot.originalText),
      check('ENTRY002.SEMANTIC_EQUAL', stableHash(probe.inputSnapshot.semantic || {}, 'entry-semantic')
        === stableHash(directSemantic || {}, 'entry-semantic'), directSemantic, probe.inputSnapshot.semantic)
    ];
  } finally {
    direct.dispose();
  }
}

async function entry003() {
  const probe = await entryProbe('voice', VOICE_ORDER_TEXT, { caseId: 'ENTRY-003' });
  const direct = await runDirectInput(VOICE_ORDER_TEXT, { caseId: 'ENTRY-003-DIRECT', source: 'voice' });
  try {
    const voiceEvents = probe.action.voiceAudit.events || [];
    return [
      ...standardHandoffChecks('ENTRY003', probe, 'voice', VOICE_ORDER_TEXT),
      check('ENTRY003.REAL_FINAL_DELIVERED', voiceEvents.some((entry) => entry.type === 'FINAL_CALLBACK'),
        true, voiceEvents, 'DASHBOARD_PAGE_VM'),
      check('ENTRY003.NO_HOLD_GESTURE_CALL', allZero(probe.action.voiceGestureCalls),
        0, probe.action.voiceGestureCalls),
      check('ENTRY003.SEMANTIC_EQUAL', stableHash(probe.inputSnapshot.semantic || {}, 'entry-semantic')
        === stableHash(semanticProjection(direct.input.page) || {}, 'entry-semantic'),
      semanticProjection(direct.input.page), probe.inputSnapshot.semantic)
    ];
  } finally {
    direct.dispose();
  }
}

async function entry004() {
  const direct = await runDirectInput(VOICE_ORDER_TEXT, { caseId: 'ENTRY-004-DIRECT' });
  try {
    const expected = semanticProjection(direct.input.page);
    const probes = [];
    for (const source of ['typed', 'paste', 'voice']) {
      probes.push([source, await entryProbe(source, VOICE_ORDER_TEXT, { caseId: `ENTRY-004-${source}` })]);
    }
    return probes.flatMap(([source, probe]) => [
      check(`ENTRY004.${source.toUpperCase()}.AUTOPARSE`, probe.input.runParseCalls === 1, 1, probe.input.runParseCalls),
      check(`ENTRY004.${source.toUpperCase()}.SOURCE_CONSUMED`, probe.inputSnapshot.source === source
        && probe.inputSnapshot.resultSource === source, source, {
          dataSource: probe.inputSnapshot.source,
          resultSource: probe.inputSnapshot.resultSource
        }),
      check(`ENTRY004.${source.toUpperCase()}.SEMANTIC_EQUAL`, stableHash(probe.inputSnapshot.semantic || {}, 'entry-semantic')
        === stableHash(expected || {}, 'entry-semantic'), expected, probe.inputSnapshot.semantic)
    ]);
  } finally {
    direct.dispose();
  }
}

async function entry005() {
  const probes = [];
  for (const source of ['typed', 'paste', 'voice']) {
    probes.push([source, await entryProbe(source, source === 'voice' ? VOICE_ORDER_TEXT : SIMPLE_ORDER_TEXT, {
      caseId: `ENTRY-005-${source}`
    })]);
  }
  return probes.flatMap(([source, probe]) => [
    check(`ENTRY005.${source.toUpperCase()}.OLD_MODAL_FALSE`, !probe.dashboard.hasOldModalState,
      false, probe.dashboard.hasOldModalState, 'DASHBOARD_PAGE_VM'),
    check(`ENTRY005.${source.toUpperCase()}.NEW_FLOW_REACHED`, probe.input.runParseCalls === 1,
      1, probe.input.runParseCalls)
  ]);
}

async function entry006() {
  const probes = [];
  for (const source of ['typed', 'paste', 'voice']) {
    probes.push([source, await entryProbe(source, source === 'voice' ? VOICE_ORDER_TEXT : SIMPLE_ORDER_TEXT, {
      caseId: `ENTRY-006-${source}`
    })]);
  }
  return probes.flatMap(([source, probe]) => [
    check(`ENTRY006.${source.toUpperCase()}.DASHBOARD_PARSE_ZERO`, probe.dashboard.quickParseCalls === 0,
      0, probe.dashboard.quickParseCalls),
    check(`ENTRY006.${source.toUpperCase()}.DASHBOARD_PARSER_ZERO`, probe.action.parserObservation.hybridInvocationCount === 0
      && probe.action.parserObservation.rawInvocationCount === 0, 0, probe.action.parserObservation),
    check(`ENTRY006.${source.toUpperCase()}.DASHBOARD_AI_ZERO`, probe.dashboardNetwork.count === 0,
      0, probe.dashboardNetwork),
    check(`ENTRY006.${source.toUpperCase()}.INPUT_REACHED`, probe.input.runParseCalls === 1,
      1, probe.input.runParseCalls),
    check(`ENTRY006.${source.toUpperCase()}.OLD_HANDLERS_ZERO`, probe.dashboard.formalCalls === 0
      && probe.dashboard.pendingCalls === 0, 0, probe.dashboard),
    check(`ENTRY006.${source.toUpperCase()}.WRITERS_ZERO`, businessCallsZero(probe.dashboard)
      && businessCallsZero(probe.input), 0, { dashboard: probe.dashboard, input: probe.input }),
    check(`ENTRY006.${source.toUpperCase()}.STATE_ZERO`, probe.mutation.zero, true, probe.mutation)
  ]);
}

async function entry007() {
  const probe = await entryProbe('typed', MULTI_ITEM_TEXT, { caseId: 'ENTRY-007' });
  const deepCount = probe.network.paths.filter((entry) => entry === '/api/ai/parse/deep').length;
  return [
    check('ENTRY007.DASHBOARD_PARSE_ZERO', probe.dashboard.quickParseCalls === 0, 0, probe.dashboard.quickParseCalls),
    check('ENTRY007.DASHBOARD_PARSER_ZERO', probe.action.parserObservation.hybridInvocationCount === 0
      && probe.action.parserObservation.rawInvocationCount === 0, 0, probe.action.parserObservation),
    check('ENTRY007.DASHBOARD_AI_ZERO', probe.dashboardNetwork.count === 0, 0, probe.dashboardNetwork),
    check('ENTRY007.MANUAL_DEEP_ZERO', probe.dashboard.deepCalls === 0 && !probe.dashboard.oldDeepVisible,
      0, { calls: probe.dashboard.deepCalls, visible: probe.dashboard.oldDeepVisible }),
    check('ENTRY007.INPUT_AUTOPARSE_ONCE', probe.input.runParseCalls === 1, 1, probe.input.runParseCalls),
    check('ENTRY007.AUTO_DEEP_ONCE', deepCount === 1, 1, probe.network),
    check('ENTRY007.FINAL_CONVERSATION', ['CLARIFYING', 'CONFIRMING', 'SAFE_BLOCKED'].includes(probe.inputSnapshot.phase),
      'settled Conversation phase', probe.inputSnapshot.phase),
    check('ENTRY007.NO_MUTATION', probe.mutation.zero && businessCallsZero(probe.input), true, {
      input: probe.input, mutation: probe.mutation
    })
  ];
}

async function entry008() {
  return withHarness({ caseId: 'ENTRY-008', navigationMode: 'DEFERRED' }, async (harness) => {
    await invokeDashboardSource(harness, 'typed', SIMPLE_ORDER_TEXT);
    harness.navigation.settle(0, 'SUCCESS');
    await harness.followInputNavigation();
    const first = inputSnapshot(harness);
    await harness.showInput();
    harness.navigation.settle(0, 'SUCCESS');
    await harness.showInput();
    const final = inputSnapshot(harness);
    const handoff = harness.handoffObserver.audit();
    return [
      check('ENTRY008.PUBLISH_ONCE', handoff.publishCalls.length === 1, 1, handoff.publishCalls),
      check('ENTRY008.CONSUME_ONCE', handoff.consumeCalls.length === 1, 1, handoff.consumeCalls),
      check('ENTRY008.AUTOPARSE_ONCE', final.runParseCalls === 1, 1, final.runParseCalls),
      check('ENTRY008.REPLAY_NO_CHANGE', first.text === final.text && first.session === final.session
        && first.route === final.route, first, final),
      check('ENTRY008.NO_MUTATION', stateMutationEvidence(harness).zero
        && businessCallsZero(inputAuthorityEvidence(harness)), true, stateMutationEvidence(harness))
    ];
  });
}

async function entry009() {
  return withHarness({ caseId: 'ENTRY-009', navigationMode: 'DEFERRED' }, async (harness) => {
    await invokeDashboardSource(harness, 'typed', STALE_TEXT_A);
    harness.navigation.settle(0, 'SUCCESS');
    await harness.followInputNavigation();
    harness.input.page.onTextInput(inputEvent(NEW_TEXT_B));
    await settlePage(harness.input.page);
    const beforeReplay = inputSnapshot(harness);
    harness.navigation.settle(0, 'SUCCESS');
    await harness.showInput();
    const afterReplay = inputSnapshot(harness);
    const handoff = harness.handoffObserver.audit();
    return [
      check('ENTRY009.A_WAS_PUBLISHED', handoff.publishCalls.length === 1, 1, handoff.publishCalls),
      check('ENTRY009.A_WAS_CONSUMED', handoff.consumeCalls.length === 1, 1, handoff.consumeCalls),
      check('ENTRY009.A_PARSED_ONCE', beforeReplay.runParseCalls === 1, 1, beforeReplay.runParseCalls),
      check('ENTRY009.NEW_TEXT_RETAINED', afterReplay.text === NEW_TEXT_B, NEW_TEXT_B, afterReplay.text),
      check('ENTRY009.OLD_TEXT_NOT_REPLAYED', afterReplay.text !== STALE_TEXT_A, 'not stale A', afterReplay.text),
      check('ENTRY009.NO_EXTRA_PARSE', afterReplay.runParseCalls === beforeReplay.runParseCalls,
        beforeReplay.runParseCalls, afterReplay.runParseCalls),
      check('ENTRY009.IDENTITY_UNCHANGED', afterReplay.session === beforeReplay.session
        && afterReplay.route === beforeReplay.route, beforeReplay, afterReplay),
      check('ENTRY009.FULL_CONVERSATION_UNCHANGED', afterReplay.securityHash === beforeReplay.securityHash,
        beforeReplay.securityHash, afterReplay.securityHash),
      check('ENTRY009.NO_MUTATION', stateMutationEvidence(harness).zero
        && businessCallsZero(inputAuthorityEvidence(harness)), true, stateMutationEvidence(harness))
    ];
  });
}

async function entry010() {
  return withHarness({ caseId: 'ENTRY-010', navigationMode: 'DEFERRED' }, async (harness) => {
    await invokeDashboardSource(harness, 'typed', STALE_TEXT_A);
    await invokeDashboardSource(harness, 'typed', NEW_TEXT_B);
    const composerAfterB = String(harness.dashboard.page.data.composerText || '');
    harness.navigation.settle(0, 'FAIL');
    if (typeof harness.dashboard.page.onHide === 'function') harness.dashboard.page.onHide();
    await harness.showInput();
    const first = inputSnapshot(harness);
    harness.navigation.settle(1, 'SUCCESS');
    harness.navigation.settle(0, 'SUCCESS');
    await harness.showInput();
    const final = inputSnapshot(harness);
    const handoff = harness.handoffObserver.audit();
    const aInvalidation = handoff.invalidateCalls.find((entry) => (
      Array.isArray(entry.matchesPublishResultIndices)
      && entry.matchesPublishResultIndices.includes(0)
      && !entry.matchesPublishResultIndices.includes(1)
    ));
    const latestWins = first.text === NEW_TEXT_B && final.text === NEW_TEXT_B && final.runParseCalls === 1;
    return [
      check('ENTRY010.PUBLISH_TWICE', handoff.publishCalls.length === 2, 2, handoff.publishCalls),
      check('ENTRY010.EXACT_A_INVALIDATION', Boolean(aInvalidation),
        'A handle invalidated without matching B', handoff.invalidateCalls),
      check('ENTRY010.CONSUME_B_ONCE', handoff.consumeCalls.length === 1, 1, handoff.consumeCalls),
      check('ENTRY010.DETERMINISTIC_LATEST_WINS', latestWins, NEW_TEXT_B, {
        composerAfterB, final: final.text, first: first.text, latestWins
      }),
      check('ENTRY010.ONE_INPUT_ONLY', final.runParseCalls === 1, 1, final.runParseCalls),
      check('ENTRY010.A_FAIL_CANNOT_CLEAR_B', latestWins, true, {
        final: final.text, first: first.text
      }),
      check('ENTRY010.B_RETAINED_DURING_RACE', composerAfterB === NEW_TEXT_B, NEW_TEXT_B, composerAfterB),
      check('ENTRY010.NO_MUTATION', stateMutationEvidence(harness).zero
        && businessCallsZero(dashboardAuthorityEvidence(harness))
        && businessCallsZero(inputAuthorityEvidence(harness)), true, stateMutationEvidence(harness))
    ];
  });
}

async function entry011(prefix = 'ENTRY011') {
  return withHarness({ caseId: prefix }, async (harness) => {
    await harness.showInput();
    const snapshot = inputSnapshot(harness);
    return [
      check(`${prefix}.INPUT_PHASE`, snapshot.phase === 'INPUT', 'INPUT', snapshot.phase),
      check(`${prefix}.NO_AUTOPARSE`, snapshot.runParseCalls === 0, 0, snapshot.runParseCalls),
      check(`${prefix}.NO_OLD_TEXT`, snapshot.text === '' && snapshot.originalText === '', '', snapshot),
      check(`${prefix}.NO_HANDOFF_STORAGE`, storageTransferWrites(harness).length === 0, [], storageTransferWrites(harness)),
      check(`${prefix}.NO_MUTATION`, stateMutationEvidence(harness).zero, true, stateMutationEvidence(harness))
    ];
  });
}

async function entry012() {
  return withHarness({ caseId: 'ENTRY-012', navigationMode: 'DEFERRED' }, async (harness) => {
    await invokeDashboardSource(harness, 'typed', MISSING_PRODUCT_TEXT);
    if (typeof harness.dashboard.page.onHide === 'function') harness.dashboard.page.onHide();
    await harness.showInput();
    await harness.showInput();
    harness.navigation.settle(0, 'SUCCESS');
    await harness.showInput();
    const snapshot = inputSnapshot(harness);
    return [
      check('ENTRY012.RUN_PARSE_ONCE', snapshot.runParseCalls === 1, 1, snapshot.runParseCalls),
      check('ENTRY012.PARSER_REQUEST_AT_MOST_ONE', networkEvidence(harness).count <= 1, '<=1', networkEvidence(harness)),
      check('ENTRY012.ONE_SESSION', Boolean(snapshot.session), 'one nonempty session', snapshot.session),
      check('ENTRY012.NO_MUTATION', stateMutationEvidence(harness).zero, true, stateMutationEvidence(harness))
    ];
  });
}

async function controlPlaneProbe(source, text) {
  const clean = await runDirectInput(text, { caseId: `ENTRY-013-${source}-CLEAN`, source });
  try {
    return await withHarness({ caseId: `ENTRY-013-${source}` }, async (harness) => {
      const malicious = FORBIDDEN_HANDOFF_KEYS.reduce((output, key) => {
        output[key] = key === 'fields'
          ? { customerName: 'MALICIOUS_CONTROL', nested: { routeAuthority: 'MALICIOUS_CONTROL' } }
          : 'MALICIOUS_CONTROL';
        return output;
      }, {
        routeAuthority: 'MALICIOUS_CONTROL',
        trustedRoute: 'MALICIOUS_CONTROL',
        quality: 'MALICIOUS_CONTROL',
        reasonCodes: ['MALICIOUS_CONTROL'],
        voiceCompletionEvidence: { sessionId: 'MALICIOUS_CONTROL', transcriptFingerprint: 'MALICIOUS_CONTROL' }
      });
      harness.dashboard.page.setData(malicious);
      await invokeDashboardSource(harness, source, text);
      const inputParserCursor = parserObservationCursor();
      await harness.followInputNavigation();
      const inputParser = collectParserObservationSince(inputParserCursor);
      const audit = harness.handoffObserver.audit();
      const payload = handoffPayload(audit);
      const allowedKeys = source === 'voice'
        ? ['autoParse', 'originSurface', 'originalText', 'source', 'voiceCompletionEvidence']
        : ['autoParse', 'originSurface', 'originalText', 'source'];
      const topKeys = payload && typeof payload === 'object' ? Object.keys(payload).sort() : [];
      const unexpectedKeys = topKeys.filter((key) => !allowedKeys.includes(key));
      const missingKeys = allowedKeys.filter((key) => !topKeys.includes(key));
      const serialized = JSON.stringify({ data: harness.input.page.data, payload });
      const authorityAudit = JSON.stringify({
        consumeCalls: audit.consumeCalls,
        publishCalls: audit.publishCalls
      });
      const voiceAuthorityTokens = [
        'voiceCompletionEvidence', 'sessionId', 'utteranceId',
        'transcriptFingerprint', 'evidenceSource'
      ].filter((token) => authorityAudit.includes(token));
      const publishArgs = audit.publishCalls[0] && audit.publishCalls[0].args || [];
      const voiceEvidence = payload && payload.voiceCompletionEvidence || null;
      const voiceEvidenceValid = source !== 'voice' || Boolean(
        voiceEvidence
        && voiceEvidence.version === 'voice-completion-evidence-v1'
        && voiceEvidence.status === 'COMPLETED'
        && voiceEvidence.isFinal === true
        && voiceEvidence.source === 'VOICE_TRANSCRIPT'
        && voiceEvidence.transcriptFingerprint === createTranscriptFingerprint(
          voiceEvidence.sessionId,
          text
        )
      );
      return {
        cleanSemantic: semanticProjection(clean.input.page),
        inputSnapshot: inputSnapshot(harness),
        payload,
        checks: [
          check(`ENTRY013.${source.toUpperCase()}.REAL_PUBLISH`, audit.publishCalls.length === 1, 1, audit),
          check(`ENTRY013.${source.toUpperCase()}.EXACT_ALLOWLIST`, Boolean(payload)
            && unexpectedKeys.length === 0 && missingKeys.length === 0,
          allowedKeys, { missingKeys, topKeys, unexpectedKeys }),
          check(`ENTRY013.${source.toUpperCase()}.BUSINESS_INPUT`, Boolean(payload)
            && payload.originalText === text && payload.source === source
            && payload.originSurface === (source === 'voice' ? 'DASHBOARD_HERO' : 'HOME_QUICK')
            && payload.autoParse === true,
          {
            autoParse: true,
            originSurface: source === 'voice' ? 'DASHBOARD_HERO' : 'HOME_QUICK',
            originalText: text,
            source
          }, payload),
          check(`ENTRY013.${source.toUpperCase()}.VOICE_AUTHORITY_SCOPED`, source !== 'voice'
            ? voiceAuthorityTokens.length === 0
            : (publishArgs.length === 1 && voiceEvidenceValid
              && !authorityAudit.includes('MALICIOUS_CONTROL')
              && inputParser.hybridInvocations.every((entry) => (
                entry.voiceInputEvidence
                && entry.voiceInputEvidence.present === true
                && entry.voiceInputEvidence.fingerprintMatched === true
              ))), source === 'voice' ? 'session-issued voice evidence' : 'no voice evidence', {
              inputVoiceEvidence: inputParser.hybridInvocations.map((entry) => entry.voiceInputEvidence),
              publishArgCount: publishArgs.length,
              voiceEvidenceValid,
              voiceAuthorityTokens
            }),
          check(`ENTRY013.${source.toUpperCase()}.CONTROL_NOT_ADOPTED`, !serialized.includes('MALICIOUS_CONTROL'),
            false, serialized.includes('MALICIOUS_CONTROL')),
          check(`ENTRY013.${source.toUpperCase()}.RECOMPUTED_SEMANTICS`, stableHash(
            semanticProjection(harness.input.page) || {}, 'entry-semantic'
          ) === stableHash(semanticProjection(clean.input.page) || {}, 'entry-semantic'),
          semanticProjection(clean.input.page), semanticProjection(harness.input.page))
        ]
      };
    });
  } finally {
    clean.dispose();
  }
}

async function entry013() {
  const sources = [
    ['typed', SIMPLE_ORDER_TEXT],
    ['paste', PASTE_ORDER_TEXT],
    ['voice', VOICE_ORDER_TEXT]
  ];
  const probes = [];
  for (const [source, text] of sources) probes.push(await controlPlaneProbe(source, text));
  return probes.flatMap((probe) => probe.checks);
}

async function entry014() {
  const bindings = extractDashboardBindings();
  const probes = [];
  for (const source of ['typed', 'paste', 'voice']) {
    probes.push([source, await entryProbe(source, source === 'voice' ? VOICE_ORDER_TEXT : SIMPLE_ORDER_TEXT, {
      caseId: `ENTRY-014-${source}`
    })]);
  }
  return [
    check('ENTRY014.STATIC_ENTRY_BINDINGS', bindings.composerSubmit === 'submitComposer'
      && bindings.paste === 'pasteClipboard', { composer: 'submitComposer', paste: 'pasteClipboard' },
    { composer: bindings.composerSubmit, paste: bindings.paste }, 'STATIC_SOURCE'),
    ...probes.flatMap(([source, probe]) => [
      check(`ENTRY014.${source.toUpperCase()}.REACHABILITY_ZERO`, !probe.dashboard.hasOldModalState,
        false, probe.dashboard.hasOldModalState, 'DASHBOARD_PAGE_VM'),
      check(`ENTRY014.${source.toUpperCase()}.HANDOFF_REACHED`, probe.input.runParseCalls === 1,
        1, probe.input.runParseCalls)
    ])
  ];
}

async function navigationFailureProbe(mode) {
  const harness = createEntryHarness({ caseId: `ENTRY-015-${mode}`, navigationMode: mode });
  let actionError = null;
  try {
    try {
      await invokeDashboardSource(harness, 'typed', SIMPLE_ORDER_TEXT);
    } catch (error) {
      actionError = { code: error.code || '', message: error.message };
    }
    await harness.showInput();
    return {
      actionError,
      dashboard: dashboardAuthorityEvidence(harness),
      handoff: harness.handoffObserver.audit(),
      input: inputSnapshot(harness),
      mutation: stateMutationEvidence(harness),
      navigation: harness.navigation.audit(),
      storageTransfers: storageTransferWrites(harness),
      text: String(harness.dashboard.page.data.composerText || ''),
      feedbackText: Object.entries(harness.dashboard.page.data || {})
        .filter(([key, value]) => /error|tip|message|status/i.test(key) && typeof value === 'string')
        .map(([, value]) => value).filter(Boolean).join('\n'),
      ui: harness.fakeWx.audit().uiEvents
    };
  } finally {
    const unsettled = harness.network.audit().unsettledRequestCount;
    harness.dispose();
    if (unsettled !== 0) {
      const error = new Error(`Navigation failure probe leaked ${unsettled} request(s)`);
      error.code = 'HARNESS_UNSETTLED_REQUESTS';
      throw error;
    }
  }
}

async function entry015() {
  const fail = await navigationFailureProbe('FAIL');
  const thrown = await navigationFailureProbe('THROW');
  return [fail, thrown].flatMap((probe, index) => {
    const label = index === 0 ? 'FAIL' : 'THROW';
    const recoverable = (probe.ui || []).some((entry) => entry.type === 'TOAST' && entry.title)
      || /失败|重试|再试|稍后|无法|没能|请/.test(probe.feedbackText || '');
    return [
      check(`ENTRY015.${label}.NAV_ATTEMPTED`, probe.navigation.length === 1, 1, probe.navigation),
      check(`ENTRY015.${label}.HANDLED`, probe.actionError === null, null, probe.actionError),
      check(`ENTRY015.${label}.DASHBOARD_SAFE`, probe.dashboard.quickParseCalls === 0
        && !probe.dashboard.hasOldModalState && businessCallsZero(probe.dashboard), true, probe.dashboard),
      check(`ENTRY015.${label}.HANDOFF_REVOKED`, probe.handoff.publishCalls.length === 1
        && probe.handoff.invalidateCalls.some((entry) => (
          Array.isArray(entry.matchesPublishResultIndices)
          && entry.matchesPublishResultIndices.length === 1
          && entry.matchesPublishResultIndices[0] === 0
        )), 'exact published handle invalidated', probe.handoff),
      check(`ENTRY015.${label}.INPUT_UNTOUCHED`, probe.input.phase === 'INPUT'
        && probe.input.runParseCalls === 0, { phase: 'INPUT', runParseCalls: 0 }, probe.input),
      check(`ENTRY015.${label}.COMPOSER_RETAINED`, probe.text === SIMPLE_ORDER_TEXT, SIMPLE_ORDER_TEXT, probe.text),
      check(`ENTRY015.${label}.RECOVERABLE_FEEDBACK`, recoverable, true, { ui: probe.ui }),
      check(`ENTRY015.${label}.NO_STORAGE_OR_MUTATION`, probe.storageTransfers.length === 0
        && probe.mutation.zero, true, { mutation: probe.mutation, storage: probe.storageTransfers })
    ];
  });
}

async function entry016() {
  return withHarness({ caseId: 'ENTRY-016' }, async (harness) => {
    await invokeDashboardSource(harness, 'typed', MISSING_PRODUCT_TEXT);
    await harness.followInputNavigation();
    const clarifying = inputSnapshot(harness);
    await answerQuestion(harness.input.page, '水杯');
    await settlePage(harness.input.page);
    const confirming = inputSnapshot(harness);
    const dashboard = dashboardAuthorityEvidence(harness);
    const input = inputAuthorityEvidence(harness);
    return [
      check('ENTRY016.CLARIFYING_FIRST', clarifying.phase === 'CLARIFYING', 'CLARIFYING', clarifying.phase),
      check('ENTRY016.CONFIRMING_AFTER_ANSWER', confirming.phase === 'CONFIRMING', 'CONFIRMING', confirming.phase),
      check('ENTRY016.ORIGINAL_RETAINED', confirming.originalText === MISSING_PRODUCT_TEXT,
        MISSING_PRODUCT_TEXT, confirming.originalText),
      check('ENTRY016.NO_WRITERS', businessCallsZero(dashboard) && businessCallsZero(input), 0, { dashboard, input }),
      check('ENTRY016.STATE_ZERO', stateMutationEvidence(harness).zero, true, stateMutationEvidence(harness))
    ];
  });
}

async function green002() {
  const harness = await runDirectInput(MISSING_PRODUCT_TEXT, { caseId: 'GREEN-ENTRY-002' });
  try {
    const before = inputSnapshot(harness);
    await answerQuestion(harness.input.page, '水杯');
    await settlePage(harness.input.page);
    const after = inputSnapshot(harness);
    return [
      check('GREENENTRY002.CLARIFYING', before.phase === 'CLARIFYING', 'CLARIFYING', before.phase),
      check('GREENENTRY002.CONFIRMING', after.phase === 'CONFIRMING', 'CONFIRMING', after.phase),
      check('GREENENTRY002.ORIGINAL_RETAINED', after.originalText === MISSING_PRODUCT_TEXT,
        MISSING_PRODUCT_TEXT, after.originalText),
      check('GREENENTRY002.NO_MUTATION', stateMutationEvidence(harness).zero
        && businessCallsZero(inputAuthorityEvidence(harness)), true, stateMutationEvidence(harness))
    ];
  } finally {
    harness.dispose();
  }
}

async function green003() {
  return withHarness({ caseId: 'GREEN-ENTRY-003' }, async (harness) => {
    const page = harness.dashboard.page;
    const bindings = extractDashboardBindings();
    const queryHandler = page[bindings.query];
    const recordsHandler = page[bindings.records];
    if (typeof queryHandler === 'function') queryHandler.call(page);
    if (typeof recordsHandler === 'function') recordsHandler.call(page);
    const wxAudit = harness.fakeWx.audit();
    const nav = wxAudit.navigationEvents.concat(harness.navigation.audit());
    const authority = dashboardAuthorityEvidence(harness);
    return [
      check('GREENENTRY003.WXML_ACTIONS_BOUND', bindings.query === 'goQuery'
        && bindings.records === 'goRecords'
        && typeof queryHandler === 'function' && typeof recordsHandler === 'function',
      { query: 'goQuery', records: 'goRecords' }, {
        query: bindings.query, queryCallable: typeof queryHandler,
        records: bindings.records, recordsCallable: typeof recordsHandler
      }, 'STATIC_SOURCE'),
      check('GREENENTRY003.QUERY_NAV', nav.some((entry) => entry.type === 'NAVIGATE_TO'
        && entry.url === '/pages/query/query'), '/pages/query/query', nav),
      check('GREENENTRY003.RECORDS_NAV', nav.some((entry) => entry.type === 'SWITCH_TAB'
        && entry.url === '/pages/records/records'), '/pages/records/records', nav),
      check('GREENENTRY003.NO_INPUT_AUTHORITY', authority.quickParseCalls === 0
        && authority.formalCalls === 0 && authority.pendingCalls === 0 && authority.deepCalls === 0,
      0, authority),
      check('GREENENTRY003.VOICE_BINDINGS_PRESERVED', bindings.voiceTouchBindingsPresent,
        true, bindings, 'STATIC_SOURCE'),
      check('GREENENTRY003.NO_MUTATION', stateMutationEvidence(harness).zero, true, stateMutationEvidence(harness))
    ];
  });
}

const EXECUTORS = {
  'ENTRY-001': entry001,
  'ENTRY-002': entry002,
  'ENTRY-003': entry003,
  'ENTRY-004': entry004,
  'ENTRY-005': entry005,
  'ENTRY-006': entry006,
  'ENTRY-007': entry007,
  'ENTRY-008': entry008,
  'ENTRY-009': entry009,
  'ENTRY-010': entry010,
  'ENTRY-011': () => entry011('ENTRY011'),
  'ENTRY-012': entry012,
  'ENTRY-013': entry013,
  'ENTRY-014': entry014,
  'ENTRY-015': entry015,
  'ENTRY-016': entry016,
  'GREEN-ENTRY-001': () => entry011('GREENENTRY001'),
  'GREEN-ENTRY-002': green002,
  'GREEN-ENTRY-003': green003
};

async function executeCase(spec) {
  const execute = EXECUTORS[spec.id];
  if (!execute) {
    const error = new Error(`No executor for ${spec.id}`);
    error.code = 'TEST_DATA_ERROR';
    throw error;
  }
  return execute();
}

module.exports = { check, executeCase };
