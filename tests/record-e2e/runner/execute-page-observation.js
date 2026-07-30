const { safeClone, stableHash } = require('../../../utils/record-state-diff');
const { normalizeUnit } = require('../../../utils/units');
const { applyPageInteractions } = require('./apply-page-interactions');
const {
  businessDraftPayload,
  flushAsync,
  loadProductionPage,
  waitForPageParse
} = require('./page-vm-driver');
const {
  collectParserObservationSince
} = require('./observed-ai-parser');
const {
  resolveProductionPathObservation
} = require('./production-path-observation-registry');
const {
  validateParserInvocationGraph
} = require('./validate-parser-invocation-graph');

function routeFromResult(result = {}) {
  const decision = result.parse_route && result.parse_route.decision;
  return {
    local: 'LOCAL',
    pending: 'PENDING',
    ai_standard: 'AI_STANDARD',
    ai_deep: 'AI_DEEP',
    no_record: 'NO_RECORD'
  }[decision] || String(decision || 'NO_RECORD').toUpperCase();
}

function pageDraft(driver) {
  const { page, surface } = driver;
  const result = safeClone(page.data.parseResult || {});
  if (surface === 'FULL_PAGE') {
    result.fields = safeClone(page.data.fields || result.fields || {});
    if (page.data.operation) result.operation = page.data.operation;
    if (page.data.intent) result.intent = page.data.intent;
  }
  return result;
}

function pageSnapshot(driver) {
  const { page, surface } = driver;
  const draft = pageDraft(driver);
  return {
    surface,
    originalInput: surface === 'HOME_QUICK' ? page.data.composerText : page.data.text,
    parseResult: draft,
    fields: safeClone(draft.fields || {}),
    items: safeClone((draft.fields && draft.fields.items) || []),
    missingFields: safeClone(draft.missing_fields || []),
    conflictFields: safeClone((draft.field_conflicts || []).map((item) => (
      typeof item === 'string' ? item : item && item.field
    )).filter(Boolean)),
    candidateIds: {
      customers: (page.data.customerMatchOptions || []).map((item) => item && item.id).filter(Boolean),
      orders: (page.data.orderOptions || []).map((item) => item && item.id).filter(Boolean),
      quotations: (page.data.quotationOptions || []).map((item) => item && item.id).filter(Boolean),
      receivables: (page.data.receivableOptions || []).map((item) => item && item.id).filter(Boolean)
    },
    domainCanSaveFormal: page.data.domainCanSaveFormal === true,
    domainCanSavePending: page.data.domainCanSavePending === true,
    surfaceCanCompleteFormal: page.data.surfaceCanCompleteFormal !== false,
    effectiveCanSaveFormal: surface === 'HOME_QUICK'
      ? page.data.disableQuickSave !== true
      : page.data.disableFormalSave !== true,
    requiresFullPage: page.data.requiresFullPage === true,
    blockingCodes: safeClone(page.data.preflightBlockingReasons || []),
    requiredSelections: safeClone(
      page.data.domainPreflight && page.data.domainPreflight.requiredSelections || []
    ),
    selectedOrderId: String(
      page.data.selectedOrderId
      || draft.fields && draft.fields.orderId
      || ''
    ),
    orderSelectionConfirmed: Boolean(
      draft.fields && draft.fields.orderSelectionConfirmed === true
    ),
    preflightFingerprint: page.data.preflightFingerprint || '',
    draftBusinessHash: stableHash(businessDraftPayload(draft), 'page-draft-business-v1')
  };
}

function expectedPageInputMethod(surface, channel) {
  if (channel === 'TYPED_TEXT') {
    return surface === 'HOME_QUICK' ? 'submitComposer' : 'runParse';
  }
  if (channel === 'CLIPBOARD_CHAT') return 'pasteClipboard';
  if (channel === 'VOICE_TRANSCRIPT') {
    return surface === 'HOME_QUICK' ? 'beginVoiceRecognition' : 'startVoice';
  }
  if (channel === 'PENDING_EDIT') return 'runParse';
  return '';
}

function collectValidatedPageParserObservation(driver, actualPageMethod, surface, spec) {
  let parserObservation = collectParserObservationSince(
    driver.evidence.parserObservationCursor
  );
  const productionPathObservation = resolveProductionPathObservation({
    actualPageMethod,
    entrySurface: surface,
    inputChannel: spec.input.channel,
    hybridInvocationCount: parserObservation.hybridInvocations.length,
    rawInvocationCount: parserObservation.rawInvocationCount,
    page: driver.page
  });
  parserObservation = validateParserInvocationGraph(
    parserObservation,
    productionPathObservation
  );
  driver.evidence.actualPageMethod = actualPageMethod;
  driver.evidence.parserObservation = safeClone(parserObservation);
  driver.evidence.productionPathObservation = safeClone(productionPathObservation);
  return { parserObservation, productionPathObservation };
}

async function submitTyped(driver, text, hooks = {}) {
  const { page, surface } = driver;
  if (hooks.skipInputMethod === true) {
    throw Object.assign(new Error('Existing page input method was intentionally skipped'), {
      code: 'AUTOMATION_DRIVER_ERROR'
    });
  }
  if (surface === 'HOME_QUICK') {
    if (typeof page.onComposerInput !== 'function' || typeof page.submitComposer !== 'function') {
      throw Object.assign(new Error('Dashboard typed input method missing'), {
        code: 'AUTOMATION_DRIVER_ERROR'
      });
    }
    page.onComposerInput({ detail: { value: text } });
    page.submitComposer();
    return 'submitComposer';
  } else {
    if (typeof page.onTextInput !== 'function' || typeof page.runParse !== 'function') {
      throw Object.assign(new Error('Input page typed method missing'), {
        code: 'AUTOMATION_DRIVER_ERROR'
      });
    }
    page.onTextInput({ detail: { value: text } });
    page.runParse();
    return 'runParse';
  }
}

async function submitClipboard(driver, runtime, spec) {
  runtime.fakeWx.setClipboardText(spec.input.clipboardText || spec.input.originalText);
  if (typeof driver.page.pasteClipboard !== 'function') {
    throw Object.assign(new Error('Page clipboard method missing'), {
      code: 'AUTOMATION_DRIVER_ERROR'
    });
  }
  driver.page.pasteClipboard();
  return 'pasteClipboard';
}

async function submitVoice(driver) {
  if (driver.surface === 'HOME_QUICK') {
    if (typeof driver.page.beginVoiceRecognition !== 'function') {
      throw Object.assign(new Error('Dashboard voice method missing'), {
        code: 'AUTOMATION_DRIVER_ERROR'
      });
    }
    driver.page.beginVoiceRecognition();
    return 'beginVoiceRecognition';
  } else {
    if (typeof driver.page.startVoice !== 'function') {
      throw Object.assign(new Error('Input page voice method missing'), {
        code: 'AUTOMATION_DRIVER_ERROR'
      });
    }
    driver.page.startVoice();
    return 'startVoice';
  }
}

async function waitForVoiceTranscript(runtime, timeoutMs = 3000) {
  const started = Date.now();
  while (runtime.voice.audit().transcriptDelivered !== true) {
    if (Date.now() - started > timeoutMs) {
      throw Object.assign(new Error('Fake voice transcript was not delivered'), {
        code: 'VOICE_TRANSCRIPTION_ERROR'
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function collectPageEditConsistency(driver, interaction, beforeEdits, afterEdits) {
  const checks = [];
  if (driver.surface !== 'HOME_QUICK') return { checks, consistent: true };
  (interaction.evidence.edits || []).forEach((edit, stepIndex) => {
    if (edit.scope === 'ITEM' || !['productName', 'quantity', 'unit', 'unitPrice'].includes(edit.field)) {
      return;
    }
    const projectionBefore = edit.projectionBefore || {};
    const projectionAfter = edit.projectionAfter || {};
    const topValue = projectionAfter.topLevel
      ? projectionAfter.topLevel[edit.field]
      : afterEdits.fields[edit.field];
    const itemValue = projectionAfter.item0
      ? projectionAfter.item0[edit.field]
      : (afterEdits.items[0] && afterEdits.items[0][edit.field]);
    const topAmount = projectionAfter.derivedAmount
      ? projectionAfter.derivedAmount.topLevelAmount
      : afterEdits.fields.amount;
    const itemAmount = projectionAfter.derivedAmount
      ? projectionAfter.derivedAmount.itemTotalAmount
      : (afterEdits.items[0] && afterEdits.items[0].totalAmount);
    const originalTextPreserved = projectionBefore.originalText === projectionAfter.originalText;
    const itemCountPreserved = projectionBefore.itemsLength === projectionAfter.itemsLength;
    const requestedValue = edit.field === 'unit'
      ? normalizeUnit(edit.value)
      : edit.value;
    const fieldSynchronized = String(topValue) === String(itemValue)
      && String(topValue) === String(requestedValue);
    const derivedAmountSynchronized = String(topAmount || '') === String(itemAmount || '');
    const methodInvokedOnce = edit.methodInvocationDelta === 1;
    checks.push({
      derivedAmountSynchronized,
      field: edit.field,
      fieldSynchronized,
      itemCountPreserved,
      method: edit.method,
      methodInvokedOnce,
      originalTextPreserved,
      projectionAfter,
      projectionBefore,
      normalizedRequestedValue: safeClone(requestedValue),
      requestedValue: safeClone(edit.value),
      stepIndex,
      beforeTopValue: projectionBefore.topLevel
        ? projectionBefore.topLevel[edit.field]
        : beforeEdits.fields[edit.field],
      beforeItemValue: projectionBefore.item0
        ? projectionBefore.item0[edit.field]
        : (beforeEdits.items[0] && beforeEdits.items[0][edit.field]),
      topValue,
      itemValue,
      synchronized: fieldSynchronized
        && derivedAmountSynchronized
        && originalTextPreserved
        && itemCountPreserved
        && methodInvokedOnce
    });
  });
  const editTrace = checks.map((item) => ({
    confirmedFieldsAfterEdit: safeClone(item.projectionAfter.confirmedFields || []),
    derivedAmountAfterEachEdit: safeClone(item.projectionAfter.derivedAmount || {}),
    field: item.field,
    itemAfterEachEdit: safeClone(item.projectionAfter.item0 || {}),
    itemBeforeEdit: safeClone(item.projectionBefore.item0 || {}),
    preflightAfterEdit: safeClone(item.projectionAfter.preflight || {}),
    stepIndex: item.stepIndex,
    topLevelAfterEachEdit: safeClone(item.projectionAfter.topLevel || {}),
    topLevelBeforeEdit: safeClone(item.projectionBefore.topLevel || {})
  }));
  return {
    checks,
    editTrace,
    finalLegacyDraft: safeClone(afterEdits.parseResult || {}),
    finalSavedRecord: null,
    consistent: checks.every((item) => item.synchronized)
  };
}

async function maybeDeepReview(driver, spec) {
  if (spec.ai.profile !== 'FAKE_DEEP') return;
  await waitForPageParse(driver.page);
  if (typeof driver.page.requestDeepReview === 'function'
    && driver.page.data.parseResult
    && driver.page.data.parseResult.parse_route
    && driver.page.data.parseResult.parse_route.deep_review_available) {
    driver.page.requestDeepReview();
    await waitForPageParse(driver.page);
  }
}

async function executePageObservation(runtime, spec, options = {}) {
  if (spec.input.channel === 'PENDING_EDIT') {
    runtime.fakeWx.wx.setStorageSync('pending_to_edit', spec.input.pendingNoteId);
  }
  const surface = options.surface || spec.input.entrySurface;
  const driver = loadProductionPage(surface, runtime, spec, {
    runLifecycle: true
  });
  const rawBefore = pageSnapshot(driver);
  let actualPageMethod = expectedPageInputMethod(surface, spec.input.channel);
  try {
    if (spec.input.channel === 'TYPED_TEXT') {
      await submitTyped(driver, spec.input.originalText, options.hooks);
    } else if (spec.input.channel === 'CLIPBOARD_CHAT') {
      await submitClipboard(driver, runtime, spec);
    } else if (spec.input.channel === 'VOICE_TRANSCRIPT') {
      await submitVoice(driver);
      await waitForVoiceTranscript(runtime);
    } else if (spec.input.channel === 'PENDING_EDIT') {
      if (typeof driver.page.runParse !== 'function') {
        throw Object.assign(new Error('Pending edit parse method missing'), {
          code: 'AUTOMATION_DRIVER_ERROR'
        });
      }
      driver.page.runParse();
    } else {
      throw Object.assign(new Error(`Unsupported page input channel: ${spec.input.channel}`), {
        code: 'AUTOMATION_DRIVER_ERROR'
      });
    }
    await waitForPageParse(driver.page);
    await maybeDeepReview(driver, spec);
    await flushAsync();
    const beforeEdits = pageSnapshot(driver);
    const missingCapabilities = (spec.interaction.requiredCapabilities || [])
      .filter((capability) => driver.availableCapabilities[capability] !== true);
    const interaction = await applyPageInteractions(driver, spec.interaction, options.hooks);
    const afterEdits = pageSnapshot(driver);
    const collected = collectValidatedPageParserObservation(
      driver,
      actualPageMethod,
      surface,
      spec
    );
    const pageEditConsistency = collectPageEditConsistency(
      driver,
      interaction,
      beforeEdits,
      afterEdits
    );
    const actualPageText = afterEdits.originalInput || beforeEdits.originalInput || '';
    let clipboardEvidence = null;
    if (spec.input.channel === 'CLIPBOARD_CHAT') {
      const analysis = driver.page.data.pasteAnalysis || {};
      clipboardEvidence = {
        rawText: analysis.rawText || '',
        extractedText: analysis.extractedText || '',
        status: analysis.status || ''
      };
    }
    return {
      actualInput: {
        channel: spec.input.channel,
        originalText: spec.input.originalText,
        pageText: actualPageText,
        source: afterEdits.parseResult.source || driver.page.data.source || '',
        clipboard: clipboardEvidence
      },
      afterEdits,
      beforeEdits,
      driver,
      inputBefore: rawBefore,
      interaction,
      missingCapabilities,
      pageEditConsistency,
      parserObservation: collected.parserObservation,
      productionPathObservation: collected.productionPathObservation,
      route: routeFromResult(afterEdits.parseResult)
    };
  } catch (error) {
    try {
      const collected = collectValidatedPageParserObservation(
        driver,
        actualPageMethod,
        surface,
        spec
      );
      error.parserObservation = safeClone(collected.parserObservation);
      error.productionPathObservation = safeClone(collected.productionPathObservation);
    } catch (collectionError) {
      const partial = collectParserObservationSince(
        driver.evidence.parserObservationCursor
      );
      error.parserObservation = safeClone(partial);
      error.parserObservationCollectionFailure = {
        code: collectionError.code || 'RAW_PARSER_EVIDENCE_MISSING',
        message: collectionError.message
      };
    }
    throw error;
  }
}

module.exports = {
  executePageObservation,
  expectedPageInputMethod,
  pageDraft,
  pageSnapshot,
  routeFromResult
};
