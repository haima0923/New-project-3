const { safeClone, stableHash } = require('../../../utils/record-state-diff');
const { questionState, submitOriginalText, tick } = require('../record-confirm-interaction-v1/page-actions');
const { createPageHarness, diffCounts, stateCounts } = require('../record-confirm-interaction-v1/runtime');
const {
  questionUiContract,
  safeBlockedSurfaceStructure,
  visibleGlobalRiskBlocks
} = require('../../wechat-runtime/record-confirm-surface-v1/static-source-tests');
const {
  AMOUNT_CONFLICT_TEXT,
  MISSING_CUSTOMER_TEXT,
  MISSING_DUE_DATE_TEXT,
  MISSING_PRODUCT_TEXT,
  MULTI_ITEM_TEXT,
  SIMPLE_ORDER_TEXT,
  TWO_RISK_TEXT,
  check,
  deepMultiItemResponse
} = require('./fixtures');

function allZero(value) {
  return Object.values(value || {}).every((entry) => Number(entry || 0) === 0);
}

function fieldProjection(page, field) {
  const data = page.data || {};
  const maps = [data.riskByField, data.fieldRisks, data.fieldRiskMap];
  for (const map of maps) {
    if (map && map[field]) return map[field];
  }
  const direct = data[`${field}Risk`] || data[`${field}Issue`] || data[`${field}Error`];
  return direct || null;
}

function itemProjection(page, itemKey, field) {
  const data = page.data || {};
  const maps = [data.riskByItem, data.itemRisks, data.itemRiskMap];
  for (const map of maps) {
    const entry = map && map[itemKey];
    if (entry && (entry[field] || (entry.riskByField || {})[field])) {
      return entry[field] || entry.riskByField[field];
    }
  }
  const item = (data.confirmItems || []).find((entry) => entry.itemKey === itemKey) || {};
  return (item.riskByField || {})[field]
    || (item.risks || {})[field]
    || item[`${field}Risk`]
    || null;
}

function amountProjection(page) {
  const data = page.data || {};
  return data.amountSurface
    || data.amountDisplay
    || data.orderAmountSurface
    || fieldProjection(page, 'amount')
    || null;
}

function projectionText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return [value.message, value.text, value.riskText, value.errorText, value.calculatedText,
    value.canonicalTotalText, value.detailTotalText].filter(Boolean).join(' ');
}

function readPath(value, pathExpression) {
  return String(pathExpression || '').split('.').filter(Boolean).reduce((current, key) => (
    current === undefined || current === null ? undefined : current[key]
  ), value);
}

function resolveTemplateValue(template, data) {
  const value = String(template || '');
  const match = value.match(/^\{\{\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\}\}$/);
  return match ? readPath(data, match[1]) : value;
}

function resolvedDataset(contract, page) {
  return Object.keys(contract.actionDataset || {}).reduce((output, key) => {
    output[key] = resolveTemplateValue(contract.actionDataset[key], page.data || {});
    return output;
  }, {});
}

async function performQuestionSurfaceAnswer(page, value) {
  const contract = questionUiContract();
  const inputHandler = contract.answerInputHandler && page[contract.answerInputHandler];
  const actionHandler = contract.actionHandler && page[contract.actionHandler];
  if (!contract.ready || typeof inputHandler !== 'function' || typeof actionHandler !== 'function') {
    return { contract, error: '', supported: false };
  }
  try {
    await Promise.resolve(inputHandler.call(page, {
      currentTarget: { dataset: {} },
      detail: { value: String(value) }
    }));
    await tick();
    const dataset = resolvedDataset(contract, page);
    await Promise.resolve(actionHandler.call(page, {
      currentTarget: { dataset },
      detail: {}
    }));
    await tick();
    return { contract, dataset, error: '', supported: true };
  } catch (error) {
    return { contract, error: error.message, supported: true };
  }
}

function noMutationChecks(harness, beforeState, prefix) {
  const afterState = harness.readState();
  const deltas = diffCounts(stateCounts(beforeState), stateCounts(afterState));
  const business = harness.driver.evidence.productionBusinessCalls;
  const storage = harness.driver.evidence.productionStorageCalls;
  return [
    check(`${prefix}.STATE_COUNTS_ZERO`, allZero(deltas), true, deltas),
    check(`${prefix}.STATE_HASH_UNCHANGED`,
      stableHash(afterState, 'surface-state') === stableHash(beforeState, 'surface-state'), true,
    { after: stableHash(afterState, 'surface-state'), before: stableHash(beforeState, 'surface-state') }),
    check(`${prefix}.BUSINESS_ZERO`, Number(business.saveConfirmedDraft || 0) === 0
      && Number(business.savePendingNote || 0) === 0,
    { saveConfirmedDraft: 0, savePendingNote: 0 }, business),
    check(`${prefix}.STORAGE_ZERO`, Number(storage.saveState || 0) === 0, 0, storage.saveState || 0)
  ];
}

async function withHarness(options, execute) {
  const harness = createPageHarness(options);
  const beforeState = safeClone(harness.readState());
  try {
    return await execute(harness, beforeState);
  } finally {
    harness.dispose();
  }
}

async function surface001() {
  return withHarness({ caseId: 'SURFACE-001', text: SIMPLE_ORDER_TEXT, networkMode: 'DEFERRED' },
    async (harness, beforeState) => {
      await submitOriginalText(harness.page, SIMPLE_ORDER_TEXT);
      const data = harness.page.data;
      const item = (data.confirmItems || [])[0] || {};
      return [
        check('SURFACE001.CUSTOMER_DATA', data.fields.customerName === '王总', '王总', data.fields.customerName),
        check('SURFACE001.ITEM_DATA', item.productName === '水杯' && item.quantity === '100'
          && item.unitPrice === '5', { productName: '水杯', quantity: '100', unitPrice: '5' }, item),
        check('SURFACE001.DUE_DATE_DATA', data.fields.dueDate === '2026-08-15', '2026-08-15', data.fields.dueDate),
        check('SURFACE001.AMOUNT_DATA', data.fields.amount === '500', '500', data.fields.amount),
        check('SURFACE001.SAVE_READY', data.showFormalSaveButton === true && data.disableFormalSave === false,
          { disabled: false, visible: true }, { disabled: data.disableFormalSave, visible: data.showFormalSaveButton }),
        ...noMutationChecks(harness, beforeState, 'SURFACE001')
      ];
    });
}

async function surface002() {
  return withHarness({ caseId: 'SURFACE-002', text: MISSING_PRODUCT_TEXT, networkMode: 'DEFERRED' },
    async (harness, beforeState) => {
      await submitOriginalText(harness.page, MISSING_PRODUCT_TEXT);
      const state = questionState(harness.page);
      const target = state.question && state.question.target || {};
      return [
        check('SURFACE002.ONE_ACTIVE_QUESTION', state.queueLength === 1 && Boolean(state.question), 1, state.queueLength),
        check('SURFACE002.EXACT_PROMPT', state.prompt === '500个、每个5元、周三交，是什么商品？',
          '500个、每个5元、周三交，是什么商品？', state.prompt),
        check('SURFACE002.TARGET_PRODUCT', target.field === 'productName' && Boolean(target.itemKey),
          { field: 'productName', itemKey: 'non-empty' }, target),
        check('SURFACE002.SAVE_BLOCKED', harness.page.data.disableFormalSave === true, true,
          harness.page.data.disableFormalSave),
        check('SURFACE002.NO_DUPLICATE_GLOBAL_RISKS', visibleGlobalRiskBlocks(harness.page.data).length === 0,
          [], visibleGlobalRiskBlocks(harness.page.data)),
        ...noMutationChecks(harness, beforeState, 'SURFACE002')
      ];
    });
}

async function surface003() {
  return withHarness({ caseId: 'SURFACE-003', text: MISSING_PRODUCT_TEXT, networkMode: 'DEFERRED' },
    async (harness, beforeState) => {
      await submitOriginalText(harness.page, MISSING_PRODUCT_TEXT);
      const beforeQuestion = safeClone(questionState(harness.page).question || {});
      const beforeContext = safeClone((harness.page.data.parseResult || {}).client_confirmation_context || {});
      const answered = await performQuestionSurfaceAnswer(harness.page, '水杯');
      const state = questionState(harness.page);
      const item = (harness.page.data.confirmItems || [])[0] || {};
      const afterContext = safeClone((harness.page.data.parseResult || {}).client_confirmation_context || {});
      return [
        check('SURFACE003.WXML_EVENT_CHAIN_SUPPORTED', answered.supported === true && !answered.error, true, answered),
        check('SURFACE003.SAME_CONFIRMATION_CONTEXT', Boolean(harness.page.data.parseResult)
          && beforeQuestion.confirmationSessionId === afterContext.confirmationSessionId
          && beforeQuestion.originalTextFingerprint === afterContext.originalTextFingerprint
          && beforeContext.confirmationSessionId === afterContext.confirmationSessionId, true,
        { afterContext, beforeContext, beforeQuestion }),
        check('SURFACE003.STILL_ON_CONFIRM_CARD', harness.page.data.text === MISSING_PRODUCT_TEXT
          && Boolean(harness.page.data.parseResult), true,
        { hasParseResult: Boolean(harness.page.data.parseResult), text: harness.page.data.text }),
        check('SURFACE003.QUESTION_CLOSED', !state.question, true, state.question),
        check('SURFACE003.PRODUCT_UPDATED', item.productName === '水杯', '水杯', item.productName),
        check('SURFACE003.SAVE_RESTORED', harness.page.data.showFormalSaveButton === true
          && harness.page.data.disableFormalSave === false, { disabled: false, visible: true },
        { disabled: harness.page.data.disableFormalSave, visible: harness.page.data.showFormalSaveButton }),
        check('SURFACE003.ORIGINAL_UNCHANGED',
          harness.page.data.parseResult.original_text === MISSING_PRODUCT_TEXT, MISSING_PRODUCT_TEXT,
          harness.page.data.parseResult.original_text),
        ...noMutationChecks(harness, beforeState, 'SURFACE003')
      ];
    });
}

async function surface004() {
  return withHarness({ caseId: 'SURFACE-004', text: AMOUNT_CONFLICT_TEXT, networkMode: 'DEFERRED' },
    async (harness, beforeState) => {
      await submitOriginalText(harness.page, AMOUNT_CONFLICT_TEXT);
      const fields = harness.page.data.fields || {};
      const projection = amountProjection(harness.page);
      const surfaceText = projectionText(projection);
      return [
        check('SURFACE004.STATED_AMOUNT_PRESERVED', fields.statedAmount === '9999' && fields.amount === '9999',
          { amount: '9999', statedAmount: '9999' }, { amount: fields.amount, statedAmount: fields.statedAmount }),
        check('SURFACE004.CANONICAL_TOTAL_DATA', fields.calculatedAmount === '4676.1', '4676.1', fields.calculatedAmount),
        check('SURFACE004.BLOCKING_ISSUE_EXISTS', (harness.page.data.domainBlockingLines || [])
          .some((line) => line.includes('订单总额与商品明细合计不一致')), true,
        harness.page.data.domainBlockingLines || []),
        check('SURFACE004.AMOUNT_PROJECTION_EXISTS', Boolean(projection), true, projection),
        check('SURFACE004.SHORT_NEARBY_COPY', surfaceText.includes('总金额与商品明细合计不一致'),
          '总金额与商品明细合计不一致', surfaceText),
        check('SURFACE004.CANONICAL_TOTAL_FORMATTED', surfaceText.includes('明细合计：4676.10元'),
          '明细合计：4676.10元', surfaceText),
        check('SURFACE004.SAVE_BLOCKED', harness.page.data.disableFormalSave === true, true,
          harness.page.data.disableFormalSave),
        ...noMutationChecks(harness, beforeState, 'SURFACE004')
      ];
    });
}

async function riskProbe(caseId, text) {
  return withHarness({ caseId, text, networkMode: 'DEFERRED' }, async (harness, beforeState) => {
    await submitOriginalText(harness.page, text);
    const state = questionState(harness.page);
    const target = state.question && state.question.target || {};
    return {
      blocking: safeClone(harness.page.data.domainBlockingLines || []),
      fieldProjections: {
        customerName: safeClone(fieldProjection(harness.page, 'customerName')),
        dueDate: safeClone(fieldProjection(harness.page, 'dueDate'))
      },
      itemProjection: safeClone(itemProjection(harness.page, target.itemKey, target.field)),
      mutationChecks: noMutationChecks(harness, beforeState, `${caseId}.MUTATION`),
      question: safeClone(state)
    };
  });
}

async function surface005() {
  const product = await riskProbe('SURFACE-005-PRODUCT', MISSING_PRODUCT_TEXT);
  const customer = await riskProbe('SURFACE-005-CUSTOMER', MISSING_CUSTOMER_TEXT);
  const dueDate = await riskProbe('SURFACE-005-DUE', MISSING_DUE_DATE_TEXT);
  const productTarget = product.question.question && product.question.question.target || {};
  const projections = {
    customerName: customer.fieldProjections.customerName,
    dueDate: dueDate.fieldProjections.dueDate,
    productName: product.itemProjection
  };
  return [
    check('SURFACE005.PRODUCT_RISK_FACT_EXISTS', productTarget.field === 'productName'
      && Boolean(productTarget.itemKey), { field: 'productName', itemKey: 'non-empty' }, productTarget),
    check('SURFACE005.CUSTOMER_RISK_FACT_EXISTS', customer.blocking.some((line) => line.includes('客户称呼')),
      true, customer.blocking),
    check('SURFACE005.DUE_RISK_FACT_EXISTS', dueDate.question.question
      && dueDate.question.question.target.field === 'dueDate', 'dueDate', dueDate.question.question),
    check('SURFACE005.PROJECTIONS_EXIST', Object.values(projections).every(Boolean),
      { customerName: 'risk', dueDate: 'risk', productName: 'risk' }, projections),
    ...product.mutationChecks,
    ...customer.mutationChecks,
    ...dueDate.mutationChecks
  ];
}

async function surface006() {
  return withHarness({ caseId: 'SURFACE-006', text: SIMPLE_ORDER_TEXT, networkMode: 'DEFERRED' },
    async (harness, beforeState) => {
      await submitOriginalText(harness.page, SIMPLE_ORDER_TEXT);
      harness.page.returnToInput();
      await tick();
      return [
        check('SURFACE006.CONFIRM_CLOSED', harness.page.data.parseResult === null, null,
          harness.page.data.parseResult),
        check('SURFACE006.RAW_TEXT_EDITABLE', harness.page.data.text === SIMPLE_ORDER_TEXT, SIMPLE_ORDER_TEXT,
          harness.page.data.text),
        check('SURFACE006.RETURN_ASSIST', harness.page.data.parseAssistText.includes('已返回原内容'), true,
          harness.page.data.parseAssistText),
        ...noMutationChecks(harness, beforeState, 'SURFACE006')
      ];
    });
}

async function surface007() {
  return withHarness({ caseId: 'SURFACE-007', text: SIMPLE_ORDER_TEXT, networkMode: 'DEFERRED' },
    async (harness, beforeState) => {
      await submitOriginalText(harness.page, SIMPLE_ORDER_TEXT);
      const hasToggle = typeof harness.page.toggleOriginalText === 'function'
        || typeof harness.page.toggleOriginalTextExpanded === 'function'
        || typeof harness.page.toggleRawText === 'function';
      const toggle = harness.page.toggleOriginalText
        || harness.page.toggleOriginalTextExpanded
        || harness.page.toggleRawText;
      const initialExpanded = harness.page.data.originalTextExpanded
        ?? harness.page.data.showOriginalText
        ?? harness.page.data.showRawText;
      let expandedState;
      let collapsedAgain;
      let expandedOriginal = '';
      if (typeof toggle === 'function') {
        await Promise.resolve(toggle.call(harness.page));
        await tick();
        expandedState = harness.page.data.originalTextExpanded
          ?? harness.page.data.showOriginalText
          ?? harness.page.data.showRawText;
        expandedOriginal = String((harness.page.data.parseResult || {}).original_text || '');
        await Promise.resolve(toggle.call(harness.page));
        await tick();
        collapsedAgain = harness.page.data.originalTextExpanded
          ?? harness.page.data.showOriginalText
          ?? harness.page.data.showRawText;
      }
      return [
        check('SURFACE007.ORIGINAL_PRESERVED', harness.page.data.parseResult.original_text === SIMPLE_ORDER_TEXT,
          SIMPLE_ORDER_TEXT, harness.page.data.parseResult.original_text),
        check('SURFACE007.DEFAULT_COLLAPSED_STATE', initialExpanded === false, false, initialExpanded),
        check('SURFACE007.TOGGLE_HANDLER', hasToggle, true, hasToggle),
        check('SURFACE007.EXPANDS_FULL_ORIGINAL', expandedState === true && expandedOriginal === SIMPLE_ORDER_TEXT,
          { expanded: true, originalText: SIMPLE_ORDER_TEXT },
        { expanded: expandedState, originalText: expandedOriginal }),
        check('SURFACE007.COLLAPSES_AGAIN', collapsedAgain === false, false, collapsedAgain),
        check('SURFACE007.ORIGINAL_STILL_UNCHANGED',
          String((harness.page.data.parseResult || {}).original_text || '') === SIMPLE_ORDER_TEXT,
          SIMPLE_ORDER_TEXT, String((harness.page.data.parseResult || {}).original_text || '')),
        ...noMutationChecks(harness, beforeState, 'SURFACE007')
      ];
    });
}

async function surface008() {
  return withHarness({
    caseId: 'SURFACE-008',
    text: MULTI_ITEM_TEXT,
    networkMode: 'SUCCESS',
    response: deepMultiItemResponse()
  }, async (harness, beforeState) => {
    await submitOriginalText(harness.page, MULTI_ITEM_TEXT);
    const items = harness.page.data.confirmItems || [];
    const requests = harness.network.aiEvents();
    return [
      check('SURFACE008.AUTO_DEEP_ONCE', requests.length === 1
        && requests[0].path === '/api/ai/parse/deep', { count: 1, path: '/api/ai/parse/deep' },
      requests.map((event) => event.path)),
      check('SURFACE008.FINAL_ITEMS', items.length === 2
        && items[0].productName === '礼品盒' && items[0].spec === '大号'
        && items[1].productName === '礼品盒' && items[1].spec === '小号',
      [{ productName: '礼品盒', spec: '大号' }, { productName: '礼品盒', spec: '小号' }], items),
      check('SURFACE008.NO_MANUAL_DEEP', Number(harness.driver.evidence.pageMethodCalls.requestDeepReview || 0) === 0,
        0, harness.driver.evidence.pageMethodCalls.requestDeepReview || 0),
      check('SURFACE008.DEEP_BUTTON_HIDDEN', harness.page.data.showDeepReviewButton === false, false,
        harness.page.data.showDeepReviewButton),
      check('SURFACE008.SAVE_READY', harness.page.data.disableFormalSave === false, false,
        harness.page.data.disableFormalSave),
      ...noMutationChecks(harness, beforeState, 'SURFACE008')
    ];
  });
}

async function surface009() {
  return withHarness({ caseId: 'SURFACE-009', text: SIMPLE_ORDER_TEXT, networkMode: 'DEFERRED' },
    async (harness, beforeState) => {
      await submitOriginalText(harness.page, SIMPLE_ORDER_TEXT);
      return [
        check('SURFACE009.BUSINESS_DATA_READY', harness.page.data.fields.customerName === '王总'
          && harness.page.data.confirmItems.length === 1, true,
        { customerName: harness.page.data.fields.customerName, itemCount: harness.page.data.confirmItems.length }),
        ...noMutationChecks(harness, beforeState, 'SURFACE009')
      ];
    });
}

async function surface010() {
  return withHarness({ caseId: 'SURFACE-010', text: TWO_RISK_TEXT, networkMode: 'DEFERRED' },
    async (harness, beforeState) => {
      await submitOriginalText(harness.page, TWO_RISK_TEXT);
      const first = safeClone(questionState(harness.page));
      const firstGlobalRisks = safeClone(visibleGlobalRiskBlocks(harness.page.data));
      const answered = await performQuestionSurfaceAnswer(harness.page, '水杯');
      const second = safeClone(questionState(harness.page));
      const firstTarget = first.question && first.question.target || {};
      const secondTarget = second.question && second.question.target || {};
      return [
        check('SURFACE010.FIRST_ONLY', first.queueLength === 1 && firstTarget.field === 'productName',
          { field: 'productName', queueLength: 1 }, first),
        check('SURFACE010.WXML_EVENT_CHAIN_SUPPORTED', answered.supported === true && !answered.error,
          true, answered),
        check('SURFACE010.SECOND_ONLY_AFTER_ANSWER', second.queueLength === 1
          && secondTarget.field === 'amount', { field: 'amount', queueLength: 1 }, second),
        check('SURFACE010.QUESTIONS_DIFFER', Boolean(first.question && second.question)
          && first.question.questionId !== second.question.questionId, true,
        { first: first.question && first.question.questionId || '', second: second.question && second.question.questionId || '' }),
        check('SURFACE010.NO_DUPLICATE_GLOBAL_RISKS_FIRST', firstGlobalRisks.length === 0, [], firstGlobalRisks),
        check('SURFACE010.NO_DUPLICATE_GLOBAL_RISKS_SECOND', visibleGlobalRiskBlocks(harness.page.data).length === 0,
          [], visibleGlobalRiskBlocks(harness.page.data)),
        check('SURFACE010.SAVE_STILL_BLOCKED', harness.page.data.disableFormalSave === true, true,
          harness.page.data.disableFormalSave),
        ...noMutationChecks(harness, beforeState, 'SURFACE010')
      ];
    });
}

async function surface011() {
  return withHarness({ caseId: 'SURFACE-011', text: MISSING_PRODUCT_TEXT, networkMode: 'DEFERRED' },
    async (harness, beforeState) => {
      await submitOriginalText(harness.page, MISSING_PRODUCT_TEXT);
      const answered = await performQuestionSurfaceAnswer(harness.page, '水杯');
      const state = questionState(harness.page);
      const readyChecks = [
        check('SURFACE011.WXML_EVENT_CHAIN_SUPPORTED', answered.supported === true && !answered.error,
          true, answered),
        check('SURFACE011.LAST_QUESTION_CLOSED', !state.question && state.status === 'READY',
          { question: null, status: 'READY' }, state),
        check('SURFACE011.SAVE_VISIBLE', harness.page.data.showFormalSaveButton === true, true,
          harness.page.data.showFormalSaveButton),
        check('SURFACE011.SAVE_ENABLED', harness.page.data.disableFormalSave === false, false,
          harness.page.data.disableFormalSave),
        check('SURFACE011.SAVE_TEXT_CURRENT', harness.page.data.formalButtonText === '确认保存', '确认保存',
          harness.page.data.formalButtonText),
        check('SURFACE011.NO_STALE_BLOCKED_COPY', harness.page.data.formalButtonText !== '补齐后保存', true,
          harness.page.data.formalButtonText)
      ];
      if (answered.supported && !answered.error && harness.page.data.disableFormalSave === false) {
        harness.page.saveFormal();
        await tick();
      }
      const afterState = harness.readState();
      const deltas = diffCounts(stateCounts(beforeState), stateCounts(afterState));
      const business = harness.driver.evidence.productionBusinessCalls;
      const storage = harness.driver.evidence.productionStorageCalls;
      return readyChecks.concat([
        check('SURFACE011.SAVE_CLICK_BUSINESS_ONCE', Number(business.saveConfirmedDraft || 0) === 1,
          1, business.saveConfirmedDraft || 0),
        check('SURFACE011.SAVE_CLICK_STORAGE_ONCE', Number(storage.saveState || 0) === 1,
          1, storage.saveState || 0),
        check('SURFACE011.ONE_ORDER_CREATED', deltas.orders === 1 && deltas.pendingNotes === 0,
          { orders: 1, pendingNotes: 0 }, deltas)
      ]);
    });
}

async function surface012() {
  return withHarness({ caseId: 'SURFACE-012', text: MULTI_ITEM_TEXT, networkMode: 'TIMEOUT' },
    async (harness, beforeState) => {
      await submitOriginalText(harness.page, MULTI_ITEM_TEXT);
      const state = questionState(harness.page);
      const terminal = state.status === 'SAFE_BLOCKED' || Boolean(state.question);
      const networkAudit = harness.network.audit();
      const aiRequests = networkAudit.events.filter((event) => event.path.startsWith('/api/ai/parse'));
      const deepRequests = aiRequests.filter((event) => event.path === '/api/ai/parse/deep');
      const failure = (harness.page.data.parseResult || {}).ai_fallback || {};
      const recoveryContract = safeBlockedSurfaceStructure();
      const recoveryHandler = recoveryContract.actionHandler
        && harness.page[recoveryContract.actionHandler];
      const fallbackText = String(harness.page.data.safeBlockedMessage
        || harness.page.data.safeBlockedText
        || harness.page.data.assistantFallbackMessage
        || harness.page.data.parseAssistText
        || '');
      return [
        check('SURFACE012.AUTO_DEEP_REQUEST_ONCE', aiRequests.length === 1
          && deepRequests.length === 1, { count: 1, path: '/api/ai/parse/deep' },
        aiRequests.map((event) => ({ outcome: event.outcome, path: event.path }))),
        check('SURFACE012.TIMEOUT_CONSUMED', deepRequests[0]
          && deepRequests[0].settled === true
          && deepRequests[0].outcome === 'NETWORK_REQUEST_FAILED'
          && networkAudit.unsettledRequestCount === 0,
        { outcome: 'NETWORK_REQUEST_FAILED', settled: true, unsettledRequestCount: 0 }, {
          outcome: deepRequests[0] && deepRequests[0].outcome || '',
          settled: Boolean(deepRequests[0] && deepRequests[0].settled),
          unsettledRequestCount: networkAudit.unsettledRequestCount
        }),
        check('SURFACE012.FAILURE_METADATA', failure.attempted === true
          && failure.business_result_valid === false
          && failure.code === 'NETWORK_REQUEST_FAILED'
          && failure.status === 'timed_out',
        { attempted: true, business_result_valid: false, code: 'NETWORK_REQUEST_FAILED', status: 'timed_out' },
        failure),
        check('SURFACE012.NO_MANUAL_DEEP',
          Number(harness.driver.evidence.pageMethodCalls.requestDeepReview || 0) === 0,
          0, harness.driver.evidence.pageMethodCalls.requestDeepReview || 0),
        check('SURFACE012.FAILURE_SETTLED', harness.page.data.parsing === false, false,
          harness.page.data.parsing),
        check('SURFACE012.FAILURE_SAFE_TERMINAL', terminal, 'ASK_USER or SAFE_BLOCKED',
          { prompt: state.prompt, status: state.status }),
        check('SURFACE012.USER_RECOVERY_MESSAGE', Boolean(fallbackText)
          && fallbackText.length <= 60
          && !/AI|route|Provider|requestId|HTTP|returned_uncertain|智能核对|自动核对/i.test(fallbackText),
        '简短、非技术的下一步提示', fallbackText),
        check('SURFACE012.CORE_RESULT_AVAILABLE', harness.page.data.confirmItems.length >= 1
          && harness.page.data.fields.customerName === '王总', true,
        { customerName: harness.page.data.fields.customerName, itemCount: harness.page.data.confirmItems.length }),
        check('SURFACE012.RECOVERY_HANDLER_CALLABLE', recoveryContract.action === true
          && typeof recoveryHandler === 'function',
        { action: true, handler: 'Page method' }, {
          action: recoveryContract.action,
          handler: recoveryContract.actionHandler,
          handlerType: typeof recoveryHandler
        }),
        ...noMutationChecks(harness, beforeState, 'SURFACE012')
      ];
    });
}

const EXECUTORS = {
  'SURFACE-001': surface001,
  'SURFACE-002': surface002,
  'SURFACE-003': surface003,
  'SURFACE-004': surface004,
  'SURFACE-005': surface005,
  'SURFACE-006': surface006,
  'SURFACE-007': surface007,
  'SURFACE-008': surface008,
  'SURFACE-009': surface009,
  'SURFACE-010': surface010,
  'SURFACE-011': surface011,
  'SURFACE-012': surface012
};

async function pageVmChecks(id) {
  return EXECUTORS[id]();
}

module.exports = {
  EXECUTORS,
  pageVmChecks
};
