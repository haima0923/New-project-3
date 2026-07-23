const { saveConfirmedDraft, savePendingNote } = require('../../utils/business');
const { INPUT_SOURCE_LABELS, INTENT_LABELS } = require('../../utils/constants');
const { parseHybridInput } = require('../../utils/ai-parser');
const { prewarmAiAuth } = require('../../utils/api-client');
const { buildParseEvidence } = require('../../utils/parse-evidence');
const { buildRecentRecords, buildTodayTasks } = require('../../utils/home-workbench');
const { requestOrderFilterReset, setNextOrderFilter, setNextRecordFilter } = require('../../utils/navigation-state');
const { getRecordDetailUrl } = require('../../utils/record-detail');
const { applyFinalParseSafety } = require('../../utils/parse-safety');
const { evaluateRecordDomainPreflight, getTrustedRecordFlowContext } = require('../../utils/record-domain-preflight');
const { getState, saveState } = require('../../utils/storage');
const { startVoiceRecognition, stopVoiceRecognition } = require('../../utils/voice-recognition');
const { getFieldLabel, isVisibleField } = require('../../utils/display');
const {
  analyzeClipboardText,
  buildNoBusinessPasteResult,
  getClipboardDiagnostics,
  getClipboardDisplayText,
  getPasteMeta,
  getSingleMessagePasteTip,
  isSingleMessageClipboard,
  isWechatChatText
} = require('../../utils/clipboard-chat');

const editableFieldOrder = [
  'customerName',
  'todoTitle',
  'productName',
  'quantity',
  'unit',
  'unitPrice',
  'amount',
  'depositAmount',
  'paymentAmount',
  'remainingAmount',
  'dueDate',
  'phone',
  'remark'
];

const editableFieldsByIntent = {
  quotation: ['customerName', 'productName', 'quantity', 'unit', 'unitPrice', 'amount', 'dueDate', 'remark'],
  order: ['customerName', 'productName', 'quantity', 'unit', 'unitPrice', 'amount', 'depositAmount', 'paymentAmount', 'dueDate', 'remark'],
  receivable: ['customerName', 'amount', 'dueDate', 'remark'],
  payment: ['customerName', 'paymentAmount', 'depositAmount', 'remainingAmount', 'amount', 'dueDate', 'remark'],
  dunning: ['todoTitle', 'customerName', 'productName', 'quantity', 'unit', 'unitPrice', 'amount', 'dueDate', 'remark'],
  todo: ['todoTitle', 'customerName', 'productName', 'quantity', 'unit', 'unitPrice', 'amount', 'dueDate', 'remark'],
  unknown: ['remark']
};

const requiredFieldsByIntent = {
  quotation: ['customerName', 'productName'],
  order: ['customerName', 'productName'],
  receivable: ['customerName', 'amount'],
  payment: ['customerName', 'paymentAmount'],
  dunning: ['customerName', 'dueDate'],
  todo: ['todoTitle', 'dueDate']
};

const requiredFieldsByOperation = {
  create_quotation: ['customerName', 'productName'],
  create_order: ['customerName', 'productName'],
  create_receivable: ['customerName', 'amount'],
  create_receivable_with_payment: ['customerName', 'amount', 'paymentAmount'],
  record_payment: ['customerName', 'paymentAmount'],
  record_order_deposit: ['customerName', 'paymentAmount'],
  create_todo: ['todoTitle', 'dueDate']
};

const digitFields = ['quantity', 'unitPrice', 'amount', 'depositAmount', 'paymentAmount', 'remainingAmount'];
const dateFields = ['dueDate'];
const VOICE_HOLD_DELAY_MS = 260;
function hasResolvedAiFallback(parseResult = {}) {
  const aiFallback = parseResult.ai_fallback || {};
  return aiFallback.status === 'used' && aiFallback.business_result_valid === true;
}
const activeReceivableStatuses = ['待收', '部分收款'];
const activeOrderStatuses = ['待生产', '生产中', '待发货', '已发货'];

function uniqueFields(fields) {
  return (fields || []).filter((field, index, array) => field && array.indexOf(field) === index);
}

function markManualField(parseResult, field) {
  return Object.assign({}, parseResult, {
    manual_fields: uniqueFields([].concat(parseResult.manual_fields || [], field))
  });
}

function hasFieldValue(fields, field) {
  return fields && fields[field] !== undefined && fields[field] !== null && fields[field] !== '';
}

function toMoney(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return 0;
  return Number(number.toFixed(2));
}

function getReceivableRemaining(receivable = {}) {
  return Math.max(0, toMoney(receivable.amount) - toMoney(receivable.paidAmount));
}

function includesCustomerName(customer, keyword) {
  if (!customer || !keyword) return false;
  const customerName = String(customer.name || '');
  const source = String(keyword || '');
  return customerName.includes(source)
    || source.includes(customerName)
    || source.includes(customerName.replace(/总$/, ''));
}

function findQuickCustomer(state, fields = {}) {
  const customers = state.customers || [];
  if (fields.customerId) {
    const byId = customers.find((customer) => customer.id === fields.customerId);
    if (byId && (!fields.customerName || includesCustomerName(byId, fields.customerName))) return byId;
  }
  if (!fields.customerName) return null;
  const matches = customers.filter((customer) => includesCustomerName(customer, fields.customerName));
  return matches.length === 1 ? matches[0] : null;
}

function hydrateQuickPaymentResult(parseResult, state = getState()) {
  if (!parseResult || parseResult.intent !== 'payment') return parseResult;
  const fields = Object.assign({}, parseResult.fields || {});
  if (!hasFieldValue(fields, 'paymentAmount') && hasFieldValue(fields, 'amount')) {
    fields.paymentAmount = fields.amount;
  }
  const customer = findQuickCustomer(state, fields);
  if (!customer) return Object.assign({}, parseResult, { fields });
  fields.customerId = customer.id;
  const sourceText = `${parseResult.original_text || ''}\n${fields.remark || ''}`;
  const isDepositPayment = fields.paymentKind === 'deposit'
    || hasFieldValue(fields, 'depositAmount')
    || /定金|订金|预付/.test(sourceText);
  if (isDepositPayment) {
    if (!hasFieldValue(fields, 'depositAmount') && hasFieldValue(fields, 'paymentAmount')) fields.depositAmount = fields.paymentAmount;
    if (!hasFieldValue(fields, 'paymentAmount') && hasFieldValue(fields, 'depositAmount')) fields.paymentAmount = fields.depositAmount;
    fields.paymentKind = 'deposit';
    const orders = (state.orders || [])
      .filter((item) => item.customerId === customer.id && activeOrderStatuses.includes(item.status || ''))
      .filter((item) => {
        if (!fields.productName) return true;
        const product = String(item.productName || '');
        return !product || String(fields.productName || '').includes(product) || sourceText.includes(product);
      });
    return Object.assign({}, parseResult, {
      operation: 'record_order_deposit',
      fields,
      requiresFullInputReason: orders.length
        ? (orders.length > 1
          ? '这个客户有多笔进行中订单，请打开完整记一笔选择定金属于哪一单。'
          : '已匹配到一笔进行中订单，请打开完整记一笔确认是否关联，或选择不关联订单。')
        : ''
    });
  }
  const receivables = (state.receivables || [])
    .filter((item) => item.customerId === customer.id && activeReceivableStatuses.includes(item.status));
  const low = uniqueFields(parseResult.low_confidence_fields || []);
  const selected = receivables.find((item) => item.id === fields.receivableId);
  if (selected && toMoney(fields.paymentAmount) > getReceivableRemaining(selected)) {
    low.push('paymentAmount');
  }
  return Object.assign({}, parseResult, {
    fields,
    low_confidence_fields: uniqueFields(low),
    requiresFullInputReason: receivables.length
      ? (receivables.length > 1
        ? '这个客户有多笔待收款，请打开完整记一笔选择本次收哪一笔。'
        : '已匹配到一笔待收款，请打开完整记一笔确认是否核销，或选择不关联本次收款。')
      : ''
  });
}

function sortEditableFields(fields) {
  return uniqueFields(fields)
    .filter(isVisibleField)
    .sort((left, right) => {
      const leftIndex = editableFieldOrder.includes(left) ? editableFieldOrder.indexOf(left) : editableFieldOrder.length;
      const rightIndex = editableFieldOrder.includes(right) ? editableFieldOrder.indexOf(right) : editableFieldOrder.length;
      return leftIndex - rightIndex;
    });
}

function getEditableFields(parseResult) {
  const intent = parseResult.intent || 'unknown';
  const fields = parseResult.fields || {};
  const baseFields = editableFieldsByIntent[intent] || editableFieldsByIntent.unknown;
  const presentFields = Object.keys(fields).filter((field) => isVisibleField(field) && hasFieldValue(fields, field));
  return sortEditableFields([]
    .concat(baseFields)
    .concat(presentFields)
    .concat(parseResult.missing_fields || [])
    .concat(parseResult.low_confidence_fields || []));
}

function normalizeEditableParseResult(parseResult, state = getState()) {
  parseResult = hydrateQuickPaymentResult(parseResult, state);
  let fields = parseResult.fields || {};
  if (parseResult.intent === 'dunning') {
    fields = Object.assign({}, fields, {
      todoType: 'dunning',
      todoTitle: fields.todoTitle || (fields.customerName ? `催${fields.customerName}款` : '')
    });
    parseResult = Object.assign({}, parseResult, {
      operation: 'create_todo',
      fields
    });
  }
  const requiredFields = parseResult.intent === 'dunning'
    ? (requiredFieldsByIntent.dunning || [])
    : (requiredFieldsByOperation[parseResult.operation] || requiredFieldsByIntent[parseResult.intent] || []);
  const missingFields = uniqueFields(requiredFields)
    .filter((field) => !hasFieldValue(fields, field))
    .filter((field) => isVisibleField(field) || requiredFields.includes(field));
  return applyFinalParseSafety(Object.assign({}, parseResult, {
    fields,
    missing_fields: missingFields,
    low_confidence_fields: uniqueFields(parseResult.low_confidence_fields || [])
  }));
}

function buildConfirmFields(parseResult, state = getState()) {
  const normalized = normalizeEditableParseResult(parseResult, state);
  const fields = normalized.fields || {};
  const suggestions = normalized.field_suggestions || {};
  const missingMap = (normalized.missing_fields || []).reduce((map, field) => {
    map[field] = true;
    return map;
  }, {});
  const lowMap = (normalized.low_confidence_fields || []).reduce((map, field) => {
    map[field] = true;
    return map;
  }, {});
  return getEditableFields(normalized).map((field) => {
    const suggestion = suggestions[field] || {};
    return {
    field,
    label: getFieldLabel(field),
    value: fields[field] || '',
    inputType: digitFields.includes(field) ? 'digit' : (field === 'phone' ? 'number' : 'text'),
    kind: dateFields.includes(field) ? 'date' : (field === 'remark' ? 'textarea' : 'input'),
    warning: missingMap[field] ? '缺少这项' : (lowMap[field] ? '请确认这项' : ''),
    suggestionText: suggestion.text || '',
    suggestionValue: suggestion.value || ''
    };
  });
}

function buildWarningText(parseResult) {
  const missing = parseResult && Array.isArray(parseResult.missing_fields) ? parseResult.missing_fields : [];
  const low = parseResult && Array.isArray(parseResult.low_confidence_fields) ? parseResult.low_confidence_fields : [];
  const conflicts = parseResult && Array.isArray(parseResult.field_conflicts) ? parseResult.field_conflicts : [];
  const safetyBlockText = getQuickSaveSafetyBlockText(parseResult);
  if (safetyBlockText) return safetyBlockText;
  if (conflicts.length) return '聊天里有互相覆盖或冲突的信息，请先确认最终字段。';
  if (!missing.length && !low.length) return '';
  if (missing.length) return '有信息还没补齐，可以先补字段，也可以先放待整理。';
  return '有信息不太确定，请改一下字段后再保存。';
}

function getQuickSaveSafetyBlockText(parseResult = {}) {
  const safety = parseResult.local_parse_safety || {};
  const aiFallback = parseResult.ai_fallback || {};
  const aiStatus = aiFallback.status || 'not_requested';
  const route = parseResult.parse_route || {};
  if (route.deep_review_available) return '这条内容需要深度核对；未核对前不能直接保存。';
  if ((safety.status === 'NEEDS_AI' || ['ai_standard', 'ai_deep'].includes(route.decision))
    && !hasResolvedAiFallback(parseResult)) {
    if (aiStatus === 'timed_out') return '智能核对等待超时，这条先放待整理。';
    if (aiStatus === 'returned_uncertain') return '智能核对没有给出可采用的业务结果，这条先放待整理。';
    if (aiStatus === 'failed') return '智能快速核对没有完成，这条先放待整理。';
    if (aiStatus === 'skipped_no_endpoint') return '这段内容比较复杂，建议先放待整理，稍后再补。';
    return '这段内容需要你重点核对，建议先放待整理。';
  }
  if (safety.status === 'NO_RECORD') return '没有识别到可直接保存的业务记录。';
  return '';
}

function getMetaText(item) {
  if (!item) return '';
  if (typeof item === 'string') return item;
  return String(item.message || item.text || item.reason || '').trim();
}

function formatFieldConflicts(conflicts) {
  return (conflicts || [])
    .map((item) => {
      if (!item || typeof item !== 'object') return getMetaText(item);
      const label = getFieldLabel(item.field || '');
      const values = Array.isArray(item.values) ? item.values.join('、') : '';
      return item.message || `${label}${values ? `有多个候选：${values}` : '不确定'}，请确认。`;
    })
    .filter(Boolean);
}

function formatSupersededFacts(facts) {
  return (facts || [])
    .map((item) => {
      if (!item || typeof item !== 'object') return getMetaText(item);
      const label = getFieldLabel(item.field || '');
      const oldValue = item.oldValue || item.old_value || item.value || '';
      const newValue = item.newValue || item.new_value || '';
      const reason = item.reason || item.message || '';
      return [label && oldValue ? `${label} ${oldValue}` : oldValue, newValue ? `已改为 ${newValue}` : '', reason].filter(Boolean).join('，');
    })
    .filter(Boolean);
}

function formatRemarkItems(items) {
  return (items || []).map(getMetaText).filter(Boolean);
}

function getFullInputConfirmationReason(parseResult = {}) {
  const fields = parseResult.fields || {};
  const items = Array.isArray(fields.items) ? fields.items.filter((item) => item && typeof item === 'object') : [];
  if (parseResult.requiresFullInputReason) return parseResult.requiresFullInputReason;
  if (parseResult.suggested_operation === 'create_receivable_with_payment') {
    return '这笔没有匹配到旧待收，请打开完整记一笔确认是否新建待收并记录本次收款。';
  }
  if (['quotation', 'order'].includes(parseResult.intent) && items.length > 1) {
    return '这笔有多件商品，请打开完整记一笔逐项确认，首页不会漏存。';
  }
  if (['quotation', 'order'].includes(parseResult.intent) && items.some((item) => item.spec)) {
    return '这笔带规格，请打开完整记一笔核对商品和规格。';
  }
  if (['quotation', 'order'].includes(parseResult.intent)
    && items.some((item) => item.unit && item.priceUnit && item.unit !== item.priceUnit && !item.totalAmount)) {
    return '数量单位和计价单位不同，请打开完整记一笔确认该项金额。';
  }
  return '';
}

function buildHomeConfirmState(parseResult, state = getState()) {
  const normalized = normalizeEditableParseResult(parseResult, state);
  const fullInputReason = getFullInputConfirmationReason(normalized);
  const flowContext = getTrustedRecordFlowContext(normalized);
  const domainPreflight = evaluateRecordDomainPreflight({
    mode: flowContext.mode || 'PRODUCTION_ROUTING',
    resultScope: flowContext.resultScope || 'PRODUCTION_RESULT',
    operation: normalized.operation,
    businessType: normalized.intent,
    finalResult: normalized,
    originalText: normalized.original_text || '',
    initialState: state,
    aiOutcome: flowContext.aiOutcome || (normalized.ai_fallback || {}).status || 'not_requested',
    providerKind: flowContext.providerKind || (normalized.ai_fallback || {}).provider_kind || 'NONE',
    skipFinalSafety: true
  });
  const relationSelectionRequired = domainPreflight.blockingIssues.some((item) => (
    ['SELECT_CUSTOMER', 'SELECT_ORDER', 'SELECT_QUOTATION', 'SELECT_RECEIVABLE', 'SELECT_TARGET']
      .includes(item.requiredAction)
  ));
  const needsFullInput = Boolean(fullInputReason) || relationSelectionRequired;
  const surfaceCanCompleteFormal = !needsFullInput;
  const quickReady = domainPreflight.domainCanSaveFormal === true && surfaceCanCompleteFormal;
  const safetyBlockText = getQuickSaveSafetyBlockText(normalized);
  const fieldConflictLines = formatFieldConflicts(normalized.field_conflicts || []);
  const supersededFactLines = formatSupersededFacts(normalized.superseded_facts || []);
  const remarkItemLines = formatRemarkItems(normalized.remark_items || []);
  return {
    parseResult: normalized,
    domainCanSaveFormal: domainPreflight.domainCanSaveFormal,
    domainCanSavePending: domainPreflight.domainCanSavePending,
    surfaceCanCompleteFormal,
    effectiveCanSaveFormal: quickReady,
    requiresFullPage: needsFullInput,
    preflightFingerprint: domainPreflight.preflightFingerprint,
    preflightBlockingReasons: domainPreflight.blockingIssues.map((item) => item.code),
    parseEvidence: buildParseEvidence(normalized),
    showParseEvidence: false,
    confirmFields: buildConfirmFields(normalized, state),
    intentLabel: INTENT_LABELS[normalized.intent] || '待确认',
    sourceLabel: INPUT_SOURCE_LABELS[normalized.source] || '输入',
    warningText: fullInputReason
      || (relationSelectionRequired ? '这笔需要选择正确的客户或关联记录，请打开完整记一笔确认。' : '')
      || buildWarningText(normalized),
    fieldConflictLines,
    showFieldConflicts: Boolean(fieldConflictLines.length),
    supersededFactLines,
    showSupersededFacts: Boolean(supersededFactLines.length),
    remarkItemLines,
    showRemarkItems: Boolean(remarkItemLines.length),
    quickSaveText: quickReady ? '确认保存' : '补齐后保存',
    disableQuickSave: !quickReady,
    showPendingButton: Boolean(domainPreflight.domainCanSavePending && (
      !domainPreflight.domainCanSaveFormal
      || needsFullInput
      || safetyBlockText
      || (normalized.missing_fields || []).length
      || (normalized.low_confidence_fields || []).length
      || fieldConflictLines.length
    )),
    showContinueInput: needsFullInput,
    // 多商品、聊天记录等内容先进入完整确认页，避免首页确认卡堆叠过多操作。
    // 在完整页里仍可由用户主动选择“深度核对”。
    showDeepReviewButton: Boolean((normalized.parse_route || {}).deep_review_available) && !needsFullInput
  };
}

function vibrateOnVoiceStart() {
  if (typeof wx === 'undefined' || typeof wx.vibrateShort !== 'function') return;
  try {
    wx.vibrateShort({ type: 'light' });
  } catch (error) {
    wx.vibrateShort();
  }
}

function refreshTabBarSelected(page) {
  if (!page || typeof page.getTabBar !== 'function') return;
  const tabBar = page.getTabBar();
  if (tabBar && typeof tabBar.updateSelected === 'function') {
    tabBar.updateSelected();
  }
}

function clearParseProgress(page) {
  (page.parseProgressTimers || []).forEach((timer) => clearTimeout(timer));
  page.parseProgressTimers = [];
  if (page.parseProgressRevealTimer) clearTimeout(page.parseProgressRevealTimer);
  page.parseProgressRevealTimer = null;
}

function startParseProgress(page, source) {
  clearParseProgress(page);
  const copy = source === 'paste'
    ? [
      ['正在整理聊天内容', '先找出客户、产品和最终说法'],
      ['正在核对前后说法', '避免把旧价格或旧数量记进去'],
      ['聊天内容比较复杂，正在复核关键内容', '请稍等，确认前不会自动保存'],
      ['网络有点慢，正在继续整理', '当前内容还留在输入框，可继续等待']
    ]
    : [
      ['正在整理这条记录', '先核对客户、金额和交期'],
      ['正在核对关键信息', '避免把金额或数量记错'],
      ['内容比较复杂，正在复核', '请稍等，确认前不会自动保存'],
      ['网络有点慢，正在继续整理', '当前内容还留在输入框，可继续等待']
    ];
  const show = () => page.setData({
    voiceOverlayVisible: true,
    voiceOverlayMode: 'processing',
    voiceOverlayTitle: copy[0][0],
    voiceOverlaySubtitle: copy[0][1],
    voiceGesture: 'send'
  });
  if (source === 'voice' || page.data.voiceOverlayVisible) {
    show();
  } else {
    // 本地规则能立即完成时不闪出遮罩，只有真的在等待时才展示过程。
    page.parseProgressRevealTimer = setTimeout(show, 180);
  }
  [2600, 7600, 15000].forEach((delay, index) => {
    page.parseProgressTimers.push(setTimeout(() => {
      if (!page.data.parsing) return;
      page.setData({
        voiceOverlayTitle: copy[index + 1][0],
        voiceOverlaySubtitle: copy[index + 1][1]
      });
    }, delay));
  });
}

function finishParseProgress(page) {
  clearParseProgress(page);
  page.setData({ voiceOverlayVisible: false });
}

Page({
  data: {
    tasks: [],
    taskTotal: 0,
    recentRecords: [],
    composerText: '',
    parsing: false,
    voiceRecording: false,
    voiceOverlayVisible: false,
    voiceOverlayMode: 'listening',
    voiceOverlayTitle: '',
    voiceOverlaySubtitle: '',
    voiceOverlayHint: '',
    voiceGesture: 'send',
    voiceTip: '',
    parseResult: null,
    parseEvidence: null,
    showParseEvidence: false,
    intentLabel: '',
    sourceLabel: '',
    confirmFields: [],
    warningText: '',
    fieldConflictLines: [],
    showFieldConflicts: false,
    supersededFactLines: [],
    showSupersededFacts: false,
    remarkItemLines: [],
    showRemarkItems: false,
    quickSaveText: '确认保存',
    disableQuickSave: false,
    showPendingButton: false,
    showContinueInput: false,
    showDeepReviewButton: false
  },

  onShow() {
    refreshTabBarSelected(this);
    requestOrderFilterReset();
    // 先准备微信登录，避免用户说完后才把登录时间挤进 8 秒快速核对。
    prewarmAiAuth();
    this.load();
  },

  onUnload() {
    clearParseProgress(this);
    stopVoiceRecognition();
  },

  load() {
    const state = getState();
    const todayTasks = buildTodayTasks(state, Number.MAX_SAFE_INTEGER);
    this.setData({
      tasks: todayTasks.slice(0, 3),
      taskTotal: todayTasks.length,
      recentRecords: buildRecentRecords(state, 3)
    });
  },

  startVoice(event) {
    if (this.data.voiceRecording || this.voicePressTimer) return;
    const touch = event && event.touches && event.touches[0];
    this.voiceTouchStartX = touch ? touch.clientX : 0;
    this.voiceTouchStartY = touch ? touch.clientY : 0;
    this.voiceGestureTarget = 'send';
    this.voiceCanceling = false;
    this.voicePartialText = '';
    this.voicePressTimer = setTimeout(() => {
      this.voicePressTimer = null;
      this.beginVoiceRecognition();
    }, VOICE_HOLD_DELAY_MS);
  },

  beginVoiceRecognition() {
    if (this.data.voiceRecording) return;
    // 登录准备和录音并行，不占用户松手后生成确认卡的 8 秒。
    prewarmAiAuth();
    vibrateOnVoiceStart();
    this.setData({
      voiceRecording: true,
      voiceOverlayVisible: true,
      voiceOverlayMode: 'listening',
      voiceOverlayTitle: '正在听你说...',
      voiceOverlaySubtitle: '松开发送',
      voiceOverlayHint: '左上滑取消 · 右上滑转文字',
      voiceGesture: 'send',
      voiceTip: '正在听你说，松开后识别。'
    });
    const started = startVoiceRecognition({
      duration: 60000,
      lang: 'zh_CN',
      onStart: () => {
        this.setData({
          voiceRecording: true,
          voiceOverlayVisible: true,
          voiceOverlayMode: 'listening',
          voiceOverlayTitle: '正在听你说...',
          voiceOverlaySubtitle: '松开发送',
          voiceOverlayHint: '左上滑取消 · 右上滑转文字',
          voiceGesture: 'send',
          voiceTip: '正在听你说，松开后识别。'
        });
      },
      onStop: () => {
        if (this.voiceCanceling) return;
        this.setData({
          voiceRecording: false,
          voiceOverlayVisible: true,
          voiceOverlayMode: 'processing',
          voiceOverlayTitle: '正在整理...',
          voiceOverlaySubtitle: '我在判断这条记录，直接给你确认结果',
          voiceTip: '录音已结束，正在识别。'
        });
      },
      onRecognize: (result) => {
        const text = String((result && result.text) || '').trim();
        if (!text) return;
        this.voicePartialText = text;
        if (this.voiceGestureTarget !== 'send') return;
        this.setData({
          voiceOverlaySubtitle: '听到了，继续说完整句'
        });
      },
      onResult: (result) => {
        if (this.voiceCanceling) {
          this.voiceCanceling = false;
          this.voiceGestureTarget = 'send';
          return;
        }
        const text = String(result.text || this.voicePartialText || '').trim();
        if (!text) {
          this.setData({
            voiceRecording: false,
            voiceOverlayVisible: false,
            voiceTip: '没有听清楚，请再说一次或改用打字。'
          });
          wx.showToast({ title: '没有听清楚', icon: 'none' });
          return;
        }
        this.setData({
          voiceRecording: false,
          composerText: text,
          voiceTip: '已识别成文字，请确认后保存。'
        });
        this.runQuickParse(text, 'voice');
      },
      onError: (error) => {
        if (this.voiceCanceling) {
          this.voiceCanceling = false;
          this.voiceGestureTarget = 'send';
          return;
        }
        const partialText = String(this.voicePartialText || '').trim();
        if (partialText) {
          this.setData({
            voiceRecording: false,
            composerText: partialText,
            voiceTip: '已识别成文字，请确认后保存。'
          });
          this.runQuickParse(partialText, 'voice');
          return;
        }
        this.setData({
          voiceRecording: false,
          voiceOverlayVisible: false,
          voiceTip: error.message || '语音识别失败，请改用打字或粘贴。'
        });
        wx.showToast({ title: '语音识别失败', icon: 'none' });
      }
    });
    if (!started) this.setData({ voiceRecording: false, voiceOverlayVisible: false });
  },

  stopVoice() {
    if (this.voicePressTimer) {
      clearTimeout(this.voicePressTimer);
      this.voicePressTimer = null;
      this.voiceGestureTarget = 'send';
      return;
    }
    if (this.voiceGestureTarget === 'cancel') {
      this.cancelVoice();
      return;
    }
    if (this.voiceGestureTarget === 'input') {
      this.switchVoiceToTextInput();
      return;
    }
    if (this.data.voiceRecording) {
      this.setData({
        voiceOverlayVisible: true,
        voiceOverlayMode: 'processing',
        voiceOverlayTitle: '正在整理...',
        voiceOverlaySubtitle: '我在判断这条记录，直接给你确认结果',
        voiceTip: '录音已结束，正在识别。'
      });
      stopVoiceRecognition();
    }
  },

  moveVoice(event) {
    if (!this.data.voiceRecording || !this.voiceTouchStartY) return;
    const touch = event && event.touches && event.touches[0];
    if (!touch) return;
    const dx = touch.clientX - (this.voiceTouchStartX || touch.clientX);
    const dy = touch.clientY - this.voiceTouchStartY;
    let nextGesture = 'send';
    if (dy < -55 && dx < -45) nextGesture = 'cancel';
    if (dy < -55 && dx > 45) nextGesture = 'input';
    if (nextGesture === this.voiceGestureTarget) return;
    this.voiceGestureTarget = nextGesture;
    const overlayText = {
      send: {
        title: '正在听你说...',
        subtitle: '松开发送',
        hint: '左上滑取消 · 右上滑转文字'
      },
      cancel: {
        title: '松手取消',
        subtitle: '这次不会保存',
        hint: '松手取消本次录音'
      },
      input: {
        title: '转文字输入',
        subtitle: '松手去记一笔页面',
        hint: '松手后改用打字输入'
      }
    }[nextGesture];
    this.setData({
      voiceOverlayTitle: overlayText.title,
      voiceOverlaySubtitle: overlayText.subtitle,
      voiceOverlayHint: overlayText.hint,
      voiceGesture: nextGesture
    });
  },

  cancelVoice() {
    if (this.voicePressTimer) {
      clearTimeout(this.voicePressTimer);
      this.voicePressTimer = null;
      this.voiceGestureTarget = 'send';
      return;
    }
    if (!this.data.voiceRecording) return;
    this.voiceCanceling = true;
    this.voiceGestureTarget = 'send';
    this.setData({
      voiceRecording: false,
      voiceOverlayVisible: false,
      voiceTip: ''
    });
    stopVoiceRecognition();
  },

  switchVoiceToTextInput() {
    if (!this.data.voiceRecording) return;
    this.voiceCanceling = true;
    this.voiceGestureTarget = 'send';
    this.setData({
      voiceRecording: false,
      voiceOverlayVisible: false,
      voiceTip: ''
    });
    stopVoiceRecognition();
    wx.setStorageSync('force_text_input', true);
    wx.switchTab({ url: '/pages/input/input' });
  },

  onComposerInput(event) {
    const composerText = event.detail.value;
    if (String(composerText || '').trim()) prewarmAiAuth();
    this.setData({ composerText });
  },

  pasteClipboard() {
    wx.getClipboardData({
      success: (res) => {
        const analysis = analyzeClipboardText(res.data || '');
        if (!analysis.rawText) {
          wx.showToast({ title: '剪贴板是空的', icon: 'none' });
          return;
        }
        const diagnosticText = getClipboardDiagnostics(analysis);
        this.setData({
          composerText: getClipboardDisplayText(analysis),
          voiceTip: isSingleMessageClipboard(analysis)
            ? `${diagnosticText}\n${getSingleMessagePasteTip()}`
            : ([diagnosticText, analysis.warning || '正在识别有效业务内容。'].filter(Boolean).join('\n'))
        });
        if (analysis.status === 'ok') {
          this.runQuickParse(analysis.extractedText, 'paste', analysis);
          return;
        }
        if (isSingleMessageClipboard(analysis)) {
          wx.showToast({ title: '只读到1条消息', icon: 'none' });
          return;
        }
        const confirmState = buildHomeConfirmState(buildNoBusinessPasteResult(analysis));
        this.setData(Object.assign({}, confirmState, {
          parsing: false,
          voiceOverlayVisible: false,
          voiceTip: analysis.warning
        }));
      }
    });
  },

  submitComposer() {
    const text = this.data.composerText.trim();
    if (!text) {
      wx.showToast({ title: '先输入一句话', icon: 'none' });
      return;
    }
    if (isWechatChatText(text)) {
      const analysis = analyzeClipboardText(text);
      const diagnosticText = getClipboardDiagnostics(analysis);
      this.setData({
        voiceTip: [diagnosticText, analysis.warning].filter(Boolean).join('\n')
      });
      if (analysis.status === 'ok') {
        this.runQuickParse(analysis.extractedText, 'paste', analysis);
        return;
      }
      const confirmState = buildHomeConfirmState(buildNoBusinessPasteResult(analysis));
      this.setData(Object.assign({}, confirmState, {
        parsing: false,
        voiceOverlayVisible: false,
        voiceTip: analysis.warning
      }));
      return;
    }
    this.runQuickParse(text, 'typed');
  },

  runQuickParse(text, source, pasteAnalysis, reviewMode = 'standard') {
    const state = getState();
    const payload = {
      text,
      source,
      context: 'home',
      state,
      reviewMode
    };
    if (source === 'paste' && pasteAnalysis) {
      payload.rawText = pasteAnalysis.rawText;
      payload.extractedText = pasteAnalysis.extractedText || text;
      payload.pasteMeta = getPasteMeta(pasteAnalysis);
    } else if (reviewMode === 'deep' && this.data.parseResult) {
      const previous = this.data.parseResult;
      payload.rawText = previous.raw_text || previous.original_text || text;
      payload.extractedText = previous.extracted_text || text;
      payload.rawMessages = previous.raw_messages || [];
    }
    this.setData({
      parsing: true,
      voiceTip: source === 'voice' ? this.data.voiceTip : ''
    });
    startParseProgress(this, source);
    parseHybridInput(payload)
      .then((parseResult) => {
        const confirmState = buildHomeConfirmState(parseResult);
        finishParseProgress(this);
        this.setData(Object.assign({}, confirmState, {
          parsing: false,
          voiceTip: ''
        }));
      })
      .catch(() => {
        finishParseProgress(this);
        this.setData({
          parsing: false,
        });
        wx.showToast({ title: '识别失败，请稍后再试', icon: 'none' });
      });
  },

  updateConfirmField(event) {
    if (!this.data.parseResult) return;
    const field = event.currentTarget.dataset.field;
    const value = event.detail.value;
    const nextFields = Object.assign({}, this.data.parseResult.fields, {
      [field]: value
    });
    if (['customerName', 'phone'].includes(field)) {
      delete nextFields.customerId;
      delete nextFields.receivableId;
    }
    const nextResult = Object.assign({}, markManualField(this.data.parseResult, field), {
      fields: nextFields,
      missing_fields: uniqueFields(this.data.parseResult.missing_fields || []).filter((item) => item !== field),
      low_confidence_fields: uniqueFields(this.data.parseResult.low_confidence_fields || []).filter((item) => item !== field)
    });
    this.setData(buildHomeConfirmState(nextResult));
  },

  applyConfirmSuggestion(event) {
    const field = event.currentTarget.dataset.field;
    const value = event.currentTarget.dataset.value;
    if (!field || !value) return;
    this.updateConfirmField({
      currentTarget: { dataset: { field } },
      detail: { value }
    });
  },

  toggleParseEvidence() {
    this.setData({ showParseEvidence: !this.data.showParseEvidence });
  },

  requestDeepReview() {
    const parseResult = this.data.parseResult;
    if (!parseResult || !(parseResult.parse_route || {}).deep_review_available) return;
    const text = parseResult.extracted_text || parseResult.original_text || this.data.composerText;
    this.runQuickParse(text, parseResult.source || 'typed', null, 'deep');
  },

  changeConfirmDate(event) {
    if (!this.data.parseResult) return;
    const field = event.currentTarget.dataset.field || 'dueDate';
    const nextFields = Object.assign({}, this.data.parseResult.fields, {
      [field]: event.detail.value
    });
    const nextResult = Object.assign({}, markManualField(this.data.parseResult, field), {
      fields: nextFields,
      missing_fields: uniqueFields(this.data.parseResult.missing_fields || []).filter((item) => item !== field),
      low_confidence_fields: uniqueFields(this.data.parseResult.low_confidence_fields || []).filter((item) => item !== field)
    });
    this.setData(buildHomeConfirmState(nextResult));
  },

  closeConfirmCard() {
    clearParseProgress(this);
    this.setData({
      parseResult: null,
      parseEvidence: null,
      showParseEvidence: false,
      confirmFields: [],
      warningText: '',
      fieldConflictLines: [],
      showFieldConflicts: false,
      supersededFactLines: [],
      showSupersededFacts: false,
      remarkItemLines: [],
      showRemarkItems: false,
      quickSaveText: '确认保存',
      disableQuickSave: false,
      showPendingButton: false,
      showContinueInput: false,
      showDeepReviewButton: false,
      voiceTip: this.data.composerText ? '已关闭确认卡，原内容还在输入框里。' : ''
    });
  },

  confirmQuickSave() {
    if (!this.data.parseResult) return;
    const state = getState();
    const confirmState = buildHomeConfirmState(this.data.parseResult, state);
    if (confirmState.disableQuickSave) {
      this.setData(confirmState);
      wx.showToast({ title: confirmState.showFieldConflicts ? '先确认聊天里的冲突信息' : '先补齐卡片里的信息', icon: 'none' });
      return;
    }
    const saved = saveConfirmedDraft(state, confirmState.parseResult);
    if (saved.type === 'error') {
      wx.showToast({ title: saved.error || '没有保存，请核对后重试', icon: 'none' });
      return;
    }
    saveState(state, { writerSource: 'DASHBOARD_FORMAL' });
    wx.showToast({
      title: saved.type === 'pending' ? '已存待整理' : '已保存',
      icon: 'success'
    });
    this.setData({
      composerText: '',
      parseResult: null,
      parseEvidence: null,
      showParseEvidence: false,
      confirmFields: [],
      warningText: '',
      fieldConflictLines: [],
      showFieldConflicts: false,
      supersededFactLines: [],
      showSupersededFacts: false,
      remarkItemLines: [],
      showRemarkItems: false,
      quickSaveText: '确认保存',
      disableQuickSave: false,
      showPendingButton: false,
      showContinueInput: false,
      showDeepReviewButton: false
    });
    this.load();
  },

  savePendingFromConfirm() {
    if (!this.data.parseResult) return;
    const confirmState = buildHomeConfirmState(this.data.parseResult);
    const state = getState();
    savePendingNote(state, confirmState.parseResult, '用户选择稍后整理');
    saveState(state, { writerSource: 'DASHBOARD_PENDING' });
    wx.showToast({ title: '已存到待整理', icon: 'success' });
    this.setData({
      composerText: '',
      parseResult: null,
      parseEvidence: null,
      showParseEvidence: false,
      confirmFields: [],
      warningText: '',
      fieldConflictLines: [],
      showFieldConflicts: false,
      supersededFactLines: [],
      showSupersededFacts: false,
      remarkItemLines: [],
      showRemarkItems: false,
      quickSaveText: '确认保存',
      disableQuickSave: false,
      showPendingButton: false,
      showContinueInput: false,
      showDeepReviewButton: false
    });
    this.load();
  },

  continueInput() {
    const parseResult = this.data.parseResult;
    const text = parseResult ? parseResult.original_text : this.data.composerText;
    wx.setStorageSync('draft_to_input', {
      text,
      source: parseResult ? parseResult.source : 'typed'
    });
    wx.switchTab({ url: '/pages/input/input' });
  },

  goInput() {
    wx.switchTab({ url: '/pages/input/input' });
  },

  goQuery() {
    wx.navigateTo({ url: '/pages/query/query' });
  },

  goReminder() {
    wx.setStorageSync('draft_to_input', {
      text: '提醒我',
      source: 'typed'
    });
    wx.switchTab({ url: '/pages/input/input' });
  },

  goRecords() {
    wx.switchTab({ url: '/pages/records/records' });
  },

  goTodos() {
    setNextRecordFilter('workbench');
    wx.switchTab({ url: '/pages/records/records' });
  },

  handleTaskAction(event) {
    const type = event.currentTarget.dataset.type;
    if (type === 'receivable') {
      wx.setStorageSync('finance_segment', 'receivable');
      wx.switchTab({ url: '/pages/finance/finance' });
      return;
    }
    if (type === 'order') {
      setNextOrderFilter({
        preset: 'deliverySoon',
        label: '货快到期'
      });
      wx.navigateTo({ url: '/pages/orders/orders' });
      return;
    }
    if (type === 'quotation') {
      wx.navigateTo({ url: '/pages/quotations/quotations' });
      return;
    }
    if (type === 'todo') {
      wx.navigateTo({ url: '/pages/todos/todos' });
      return;
    }
    if (type === 'pending') {
      wx.navigateTo({ url: '/pages/pending/pending' });
    }
  },

  openRecent(event) {
    const url = getRecordDetailUrl(event.currentTarget.dataset.type, event.currentTarget.dataset.id);
    if (url) {
      wx.navigateTo({ url });
      return;
    }
    wx.switchTab({ url: '/pages/records/records' });
  }
});
