const { INPUT_SOURCE_LABELS, INTENT_LABELS } = require('../../utils/constants');
const { buildOrderEditDraft, findCustomerMatches, getItemsSummary, getOrderDepositAmount, getRecordItems, saveConfirmedDraft, savePendingNote } = require('../../utils/business');
const {
  getParseRouteDecision,
  parseHybridInput,
  prepareHybridLocalStage,
  requestHybridAiStage,
  ROUTE_AI_DEEP,
  ROUTE_ASK_USER,
  ROUTE_SAFE_BLOCKED
} = require('../../utils/ai-parser');
const { prewarmAiAuth } = require('../../utils/api-client');
const { buildParseEvidence } = require('../../utils/parse-evidence');
const { addDays, diffDays, parseChineseDateDetail, today } = require('../../utils/date');
const { normalizeNumberText, numberPattern, parseChineseNumber } = require('../../utils/chinese-number');
const { describeFields: describeVisibleFields, getFieldLabel, getVisibleFields } = require('../../utils/display');
const { requestOrderFilterReset } = require('../../utils/navigation-state');
const {
  consumeRecordEntryHandoff,
  hasPendingRecordEntryHandoff
} = require('../../utils/record-entry-handoff');
const {
  applyFinalParseSafety,
  collectUserResolvableAiRisks,
  createTrustedAssistantAnswerChallenge,
  createTrustedAssistantAnswerEdit,
  createTrustedUserManualEdit,
  evaluateUserResolvedAiState,
  hasTrustedAssistantAnswerEdit,
  reconcileTrustedUserManualEditState
} = require('../../utils/parse-safety');
const {
  evaluateRecordDomainPreflight,
  getCustomerNameMatchKind,
  getTrustedRecordFlowContext,
  isNoRecordPersistenceForbidden
} = require('../../utils/record-domain-preflight');
const { stableHash } = require('../../utils/record-state-diff');
const { getCatalogCheck, getProductSuggestions, getSpecSuggestions } = require('../../utils/product-catalog');
const { getCustomerDisplay, getState, saveState } = require('../../utils/storage');
const {
  cancelVoiceRecognition,
  invalidateVoiceCompletionEvidence,
  startVoiceRecognition,
  stopVoiceRecognition,
  validateVoiceCompletionEvidence
} = require('../../utils/voice-recognition');
const { normalizeUnit, unitsMatch } = require('../../utils/units');
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

const intentOptions = ['quotation', 'order', 'receivable', 'payment', 'dunning', 'todo', 'unknown'];
const NEW_CUSTOMER_OPTION_ID = '__new_customer__';
const UNLINKED_RECEIVABLE_OPTION_ID = '__unlinked_receivable__';
const UNLINKED_ORDER_OPTION_ID = '__unlinked_order__';
const DEFAULT_QUOTATION_FOLLOWUP_DAYS = 2;
const ASSISTANT_QUESTION_TYPES = new Set(['TEXT', 'DATE', 'NUMBER']);
const CONVERSATION_PHASE_INPUT = 'INPUT';
const CONVERSATION_PHASE_AUTO_REVIEW = 'AUTO_REVIEW';
const CONVERSATION_PHASE_CLARIFYING = 'CLARIFYING';
const CONVERSATION_PHASE_CONFIRMING = 'CONFIRMING';
const CONVERSATION_PHASE_SAFE_BLOCKED = 'SAFE_BLOCKED';
const CONVERSATION_PHASE_SAVING = 'SAVING';
const rawInputCaptureRegistry = new WeakMap();
const FOLLOWUP_DAY_VALUES = Array.from({ length: 30 }, (_, index) => index + 1);
const FOLLOWUP_DAY_RANGE = FOLLOWUP_DAY_VALUES.map((days) => `${days} 天`);
const intentRange = intentOptions.map((item) => INTENT_LABELS[item]);
const requiredFields = {
  create_quotation: ['customerName', 'productName'],
  create_order: ['customerName', 'productName'],
  update_quotation: ['quotationId'],
  update_order: ['orderId'],
  create_receivable: ['customerName', 'amount'],
  create_receivable_with_payment: ['customerName', 'amount', 'paymentAmount'],
  record_payment: ['customerName', 'paymentAmount'],
  record_order_deposit: ['customerName', 'paymentAmount'],
  create_todo: ['todoTitle', 'dueDate'],
  quotation: ['customerName', 'productName'],
  order: ['customerName', 'productName'],
  receivable: ['customerName', 'amount'],
  payment: ['customerName', 'paymentAmount'],
  dunning: ['customerName', 'dueDate'],
  todo: ['todoTitle', 'dueDate'],
  unknown: ['intent']
};
const warningFieldsByOperation = {
  create_quotation: ['customerName', 'productName', 'spec', 'quantity', 'unit', 'unitPrice', 'priceUnit'],
  create_order: ['customerName', 'productName', 'spec', 'quantity', 'unit', 'unitPrice', 'priceUnit', 'depositAmount', 'paymentAmount'],
  update_quotation: ['quotationId', 'customerName', 'productName', 'spec', 'quantity', 'unit', 'unitPrice', 'priceUnit', 'dueDate'],
  update_order: ['orderId', 'customerName', 'productName', 'spec', 'quantity', 'unit', 'unitPrice', 'priceUnit', 'dueDate'],
  create_receivable: ['customerName', 'amount'],
  create_receivable_with_payment: ['customerName', 'amount', 'paymentAmount', 'remainingAmount'],
  record_payment: ['customerName', 'receivableId', 'paymentAmount'],
  record_order_deposit: ['customerName', 'orderId', 'paymentAmount', 'depositAmount'],
  create_todo: ['todoTitle', 'customerName', 'productName', 'quantity', 'unit', 'unitPrice', 'dueDate'],
  pending: ['intent'],
  quotation: ['customerName', 'productName', 'spec', 'quantity', 'unit', 'unitPrice', 'priceUnit'],
  order: ['customerName', 'productName', 'spec', 'quantity', 'unit', 'unitPrice', 'priceUnit', 'depositAmount', 'paymentAmount'],
  receivable: ['customerName', 'amount'],
  payment: ['customerName', 'paymentAmount', 'depositAmount', 'remainingAmount'],
  dunning: ['customerName'],
  todo: ['todoTitle', 'customerName', 'productName', 'quantity', 'unit', 'unitPrice', 'dueDate'],
  unknown: ['intent']
};
const activeReceivableStatuses = ['待收', '部分收款'];
const activeOrderStatuses = ['待生产', '生产中', '待发货', '已发货'];
function hasResolvedAiFallback(parseResult = {}) {
  const aiFallback = parseResult.ai_fallback || {};
  return aiFallback.status === 'used' && aiFallback.business_result_valid === true;
}

function deriveConversationPhase(state = {}) {
  if (state.saving === true) return CONVERSATION_PHASE_SAVING;
  if (state.parsing === true) return CONVERSATION_PHASE_AUTO_REVIEW;
  if (state.assistantQuestionState === 'SAFE_BLOCKED') {
    return CONVERSATION_PHASE_SAFE_BLOCKED;
  }
  if (state.activeQuestion) return CONVERSATION_PHASE_CLARIFYING;
  if (state.parseResult) return CONVERSATION_PHASE_CONFIRMING;
  return CONVERSATION_PHASE_INPUT;
}

function withConversationPhase(currentState = {}, patch = {}) {
  const merged = Object.assign({}, currentState || {}, patch || {});
  return Object.assign({}, patch, {
    conversationPhase: deriveConversationPhase(merged)
  });
}

function setConversationData(page, patch, callback) {
  page.setData(withConversationPhase(page.data || {}, patch), callback);
}
const operationByIntent = {
  quotation: 'create_quotation',
  order: 'create_order',
  receivable: 'create_receivable',
  payment: 'record_payment',
  dunning: 'create_todo',
  todo: 'create_todo',
  unknown: 'pending'
};

const TYPE_SWITCH_COMMON_FIELDS = [
  'customerName', 'phone', 'customerId', 'company', 'region', 'wechatRemark',
  'customerNote', 'forceNewCustomer', 'customerHistoryConfirmed',
  'customerSelectionConfirmed', 'remark', 'originalText', 'original_text'
];
const TYPE_SWITCH_COMMERCIAL_ITEM_FIELDS = [
  'items', 'productName', 'spec', 'quantity', 'unit', 'unitPrice', 'priceUnit',
  'amount', 'totalAmount', 'calculatedAmount', 'statedAmount', 'paymentMethod'
];
const TYPE_SWITCH_TODO_FIELDS = [
  'todoTitle', 'dueDate', 'productName', 'quantity', 'unit', 'unitPrice', 'amount'
];
const TYPE_SWITCH_TARGET_FIELDS = {
  quotation: TYPE_SWITCH_COMMERCIAL_ITEM_FIELDS.concat([
    'followupDays', 'dueDate', 'quoteDate', 'validUntil'
  ]),
  order: TYPE_SWITCH_COMMERCIAL_ITEM_FIELDS.concat([
    'dueDate', 'depositAmount', 'paymentAmount', 'paymentKind'
  ]),
  receivable: ['amount', 'dueDate'],
  payment: ['amount', 'paymentAmount', 'remainingAmount', 'paymentDate', 'dueDate'],
  dunning: TYPE_SWITCH_TODO_FIELDS.concat(['todoType']),
  todo: TYPE_SWITCH_TODO_FIELDS,
  unknown: []
};

function copyTypeSwitchFieldValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => (
      item && typeof item === 'object' && !Array.isArray(item)
        ? Object.assign({}, item)
        : item
    ));
  }
  if (value && typeof value === 'object') return Object.assign({}, value);
  return value;
}

function projectTypeSwitchFields(sourceIntent, targetIntent, fields) {
  if (targetIntent === 'unknown') {
    return Object.keys(fields || {}).reduce((next, field) => {
      next[field] = copyTypeSwitchFieldValue(fields[field]);
      return next;
    }, {});
  }

  const quotationOrderTransition = ['quotation', 'order'].includes(sourceIntent)
    && ['quotation', 'order'].includes(targetIntent);
  const todoTransition = ['todo', 'dunning'].includes(sourceIntent)
    && ['todo', 'dunning'].includes(targetIntent);
  const sourceIsPending = sourceIntent === 'unknown';
  let ownedFields = TYPE_SWITCH_COMMON_FIELDS;
  if (quotationOrderTransition) {
    ownedFields = ownedFields.concat(TYPE_SWITCH_COMMERCIAL_ITEM_FIELDS);
  } else if (todoTransition) {
    ownedFields = ownedFields.concat(TYPE_SWITCH_TODO_FIELDS);
  } else if (sourceIsPending) {
    ownedFields = ownedFields.concat(TYPE_SWITCH_TARGET_FIELDS[targetIntent] || []);
  }

  const projected = uniqueFields(ownedFields).reduce((next, field) => {
    if (Object.prototype.hasOwnProperty.call(fields || {}, field)) {
      next[field] = copyTypeSwitchFieldValue(fields[field]);
    }
    return next;
  }, {});
  if (targetIntent === 'dunning') projected.todoType = 'dunning';
  return projected;
}

function transitionOwnsRiskField(fields, field) {
  if (!field || ['intent', 'businessType'].includes(field)) return false;
  if (Object.prototype.hasOwnProperty.call(fields, field)) return true;
  return Array.isArray(fields.items) && MANUAL_ITEM_FIELDS.includes(field);
}

function projectTypeSwitchResult(parseResult, sourceIntent, targetIntent, fields) {
  const projectedFields = projectTypeSwitchFields(sourceIntent, targetIntent, fields);
  const keepField = (field) => transitionOwnsRiskField(projectedFields, field);
  const projected = Object.assign({}, parseResult, {
    intent: targetIntent,
    operation: operationByIntent[targetIntent] || 'pending',
    suggested_operation: '',
    requires_existing_record: false,
    fields: projectedFields,
    missing_fields: uniqueFields(parseResult.missing_fields || []).filter(keepField),
    low_confidence_fields: uniqueFields(parseResult.low_confidence_fields || []).filter(keepField),
    field_conflicts: (Array.isArray(parseResult.field_conflicts)
      ? parseResult.field_conflicts
      : []).filter((conflict) => keepField(conflict && conflict.field)),
    manual_fields: uniqueFields(parseResult.manual_fields || []).filter(keepField),
    manual_item_fields: Array.isArray(projectedFields.items)
      ? normalizeManualItemFields(parseResult.manual_item_fields, projectedFields.items)
      : [],
    user_manual_edits: (Array.isArray(parseResult.user_manual_edits)
      ? parseResult.user_manual_edits
      : []).filter((proof) => keepField(proof && proof.field)),
    history_defaulted_fields: uniqueFields(parseResult.history_defaulted_fields || []).filter(keepField),
    relation_references: {},
    intent_evidence: {}
  });
  if (parseResult.field_suggestions && typeof parseResult.field_suggestions === 'object') {
    projected.field_suggestions = Object.keys(parseResult.field_suggestions)
      .filter(keepField)
      .reduce((next, field) => {
        next[field] = parseResult.field_suggestions[field];
        return next;
      }, {});
  }
  delete projected.edit_mode;
  delete projected.existing_record_id;
  return projected;
}

const operationTitles = {
  create_quotation: '保存为报价',
  create_order: '保存为订单',
  update_quotation: '更新报价',
  update_order: '更新订单',
  create_receivable: '保存为待收款 / 欠款',
  create_receivable_with_payment: '新建待收款并记录本次收款',
  record_payment: '记录收款',
  record_order_deposit: '记录订单定金',
  create_todo: '保存为待办提醒',
  pending: '待整理记录'
};
const fieldLabels = {
  intent: '业务类型',
  customerName: '客户称呼',
  phone: '手机号',
  todoTitle: '待办事项',
  orderId: '匹配订单',
  quotationId: '匹配报价',
  receivableId: '匹配待收款 / 欠款',
  productName: '产品/规格',
  quantity: '数量',
  unit: '单位',
  unitPrice: '单价',
  amount: '金额/总价',
  depositAmount: '定金金额',
  paymentAmount: '本次收款',
  remainingAmount: '剩余金额',
  dueDate: '日期',
  remark: '备注'
};

const sourceButtonConfig = {
  typed: {
    typedClass: 'segment active',
    pasteClass: 'segment',
    voiceClass: 'segment',
    showPaste: false,
    showVoice: false
  },
  paste: {
    typedClass: 'segment',
    pasteClass: 'segment active',
    voiceClass: 'segment',
    showPaste: true,
    showVoice: false
  },
  voice: {
    typedClass: 'segment',
    pasteClass: 'segment',
    voiceClass: 'segment active',
    showPaste: false,
    showVoice: true
  }
};

const surfaceConfirmTitles = {
  quotation: '确认报价',
  order: '确认订单',
  receivable: '确认待收',
  payment: '确认收款',
  dunning: '确认催款提醒',
  todo: '确认待办',
  unknown: '确认这条记录'
};

const surfaceRiskMessages = {
  customerName: '请填写客户称呼',
  dueDate: '请确认交货日期',
  amount: '请确认总金额',
  productName: '请确认商品名称',
  spec: '请确认商品规格',
  quantity: '请填写这个商品的数量',
  unit: '请确认商品单位',
  unitPrice: '请确认商品单价',
  priceUnit: '请确认计价单位',
  totalAmount: '请确认这个商品的金额'
};

const surfacePlacedRootFields = new Set([
  'amount',
  'customerName',
  'dueDate',
  'productName'
]);

const surfaceUnplacedRiskMessages = {
  businessType: '请确认业务类型',
  intent: '请确认业务类型',
  orderId: '请确认关联订单',
  paymentAmount: '请确认收款金额',
  quotationId: '请确认关联报价',
  relationId: '请确认关联记录',
  remainingAmount: '请确认待收金额',
  todoTitle: '请填写待办事项'
};

function rejectNoRecordPageAction(page, parseResult, code) {
  if (!isNoRecordPersistenceForbidden(parseResult || {})) return null;
  const rejection = {
    blocked: true,
    code,
    noBusinessCall: true,
    noStorageCall: true
  };
  page.setData({ lastNoRecordActionRejection: rejection });
  wx.showToast({ title: '没有识别到需要记录的生意事项', icon: 'none' });
  return rejection;
}

function hasFieldValue(fields, field) {
  return fields[field] !== undefined && fields[field] !== null && fields[field] !== '';
}

function getMissing(intent, fields, operation) {
  return (requiredFields[operation] || requiredFields[intent] || []).filter((field) => !hasFieldValue(fields, field));
}

function uniqueFields(fields) {
  return (Array.isArray(fields) ? fields : [])
    .filter((field) => typeof field === 'string' && field)
    .filter((field, index, array) => array.indexOf(field) === index);
}

function markManualField(parseResult, field, fields) {
  const marked = Object.assign({}, parseResult, {
    manual_fields: uniqueFields([].concat(
      Array.isArray(parseResult.manual_fields) ? parseResult.manual_fields : [],
      field
    ))
  });
  return createTrustedUserManualEdit(marked, {
    field,
    fields: fields || parseResult.fields || {}
  });
}

const MANUAL_ITEM_FIELDS = [
  'productName', 'spec', 'quantity', 'unit', 'unitPrice', 'priceUnit',
  'totalAmount', 'itemDeliveryDate', 'itemRemark'
];

function itemKeyHash(value) {
  const text = String(value || 'item');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function createConfirmationItemKey(item, index, usedKeys) {
  const identity = [index, item.productName || '', item.spec || ''].join('|');
  const base = `mip_page_${itemKeyHash(identity)}`;
  let itemKey = base;
  let suffix = 1;
  while (usedKeys.has(itemKey)) {
    itemKey = `${base}_${suffix}`;
    suffix += 1;
  }
  return itemKey;
}

function normalizeManualItemFields(value, items) {
  if (!Array.isArray(value)) return [];
  const allowedKeys = new Set(items
    .map((item) => String(item && item.confirmationItemKey || '').trim())
    .filter(Boolean));
  const seen = new Set();
  return value.reduce((output, entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return output;
    const itemKey = String(entry.itemKey || '').trim();
    const field = String(entry.field || '').trim();
    if (!allowedKeys.has(itemKey) || !MANUAL_ITEM_FIELDS.includes(field)) return output;
    const identity = `${itemKey}:${field}`;
    if (seen.has(identity)) return output;
    seen.add(identity);
    output.push({ itemKey, field });
    return output;
  }, []);
}

function markManualItemField(parseResult, fields, itemKey, field) {
  if (!MANUAL_ITEM_FIELDS.includes(field)) return parseResult;
  const items = Array.isArray(fields && fields.items) ? fields.items : [];
  const marked = Object.assign({}, parseResult, {
    manual_item_fields: normalizeManualItemFields([].concat(
      Array.isArray(parseResult.manual_item_fields) ? parseResult.manual_item_fields : [],
      { itemKey, field }
    ), items)
  });
  return createTrustedUserManualEdit(marked, {
    field,
    itemKey,
    fields: fields || parseResult.fields || {}
  });
}

function resolveConfirmationItemIndex(items, dataset = {}) {
  const itemKey = String(dataset.itemKey || '').trim();
  if (itemKey) return items.findIndex((item) => (
    String(item.confirmationItemKey || '').trim() === itemKey
  ));
  const index = Number(dataset.index || 0);
  return Number.isInteger(index) ? index : -1;
}

function pruneItemProvenance(parseResult, items) {
  const itemIndexByKey = new Map(items.map((item, index) => [
    String(item.confirmationItemKey || ''),
    index
  ]));
  const fieldConflicts = (Array.isArray(parseResult.field_conflicts)
    ? parseResult.field_conflicts
    : []).reduce((output, conflict) => {
    if (!conflict || conflict.field !== 'items' || !conflict.itemKey) {
      output.push(conflict);
      return output;
    }
    const itemKey = String(conflict.itemKey);
    if (!itemIndexByKey.has(itemKey)) return output;
    const itemIndex = itemIndexByKey.get(itemKey);
    const itemField = String(conflict.itemField || '').trim();
    output.push(Object.assign({}, conflict, {
      itemIndex,
      fieldPath: itemField && itemField !== 'identity'
        ? `items[${itemIndex}].${itemField}`
        : (conflict.fieldPath || 'items')
    }));
    return output;
  }, []);
  return Object.assign({}, parseResult, {
    manual_item_fields: normalizeManualItemFields(parseResult.manual_item_fields, items),
    field_conflicts: fieldConflicts
  });
}

function getSavedRecordId(saved = {}) {
  const record = saved.record || {};
  return record.id
    || (record.order && record.order.id)
    || (record.receivable && record.receivable.id)
    || (record.payment && record.payment.id)
    || '';
}

function updatePendingNote(state, pendingId, parseResult, reason) {
  const note = (state.pendingNotes || []).find((item) => item.id === pendingId && item.status === '待整理');
  if (!note) return null;
  note.originalText = parseResult.original_text || note.originalText || '';
  note.guessedIntent = parseResult.intent;
  note.guessedFields = parseResult.fields || {};
  note.missingFields = parseResult.missing_fields || [];
  note.lowConfidenceFields = parseResult.low_confidence_fields || [];
  note.fieldConflicts = parseResult.field_conflicts || [];
  note.source = parseResult.source || note.source || 'typed';
  note.reason = reason || note.reason || '信息不完整，需要稍后整理';
  note.updatedAt = new Date().toISOString();
  return note;
}

function markPendingNoteConverted(state, pendingId, saved) {
  if (!pendingId || !saved || saved.type === 'pending') return;
  const note = (state.pendingNotes || []).find((item) => item.id === pendingId && item.status === '待整理');
  if (!note) return;
  note.status = '已转正式记录';
  note.convertedRecordType = saved.type;
  note.convertedRecordId = getSavedRecordId(saved);
  note.updatedAt = new Date().toISOString();
}

function getWarningFields(intent, operation) {
  return warningFieldsByOperation[operation] || warningFieldsByOperation[intent] || requiredFields[operation] || requiredFields[intent] || [];
}

function filterRelevantWarningFields(fields, intent, operation) {
  const allowed = getWarningFields(intent, operation);
  return uniqueFields(fields).filter((field) => allowed.includes(field));
}

function mergeMissing(intent, fields, aiMissingFields, operation) {
  const required = requiredFields[operation] || requiredFields[intent] || [];
  const stillMissing = uniqueFields(aiMissingFields || [])
    .filter((field) => required.includes(field))
    .filter((field) => !hasFieldValue(fields, field));
  return uniqueFields([].concat(stillMissing, getMissing(intent, fields, operation)));
}

function describeFields(fields) {
  return uniqueFields(fields).map((field) => getFieldLabel(field)).join('、');
}

function getFieldFlagMap(fields) {
  return uniqueFields(fields).reduce((map, field) => {
    map[field] = true;
    return map;
  }, {});
}

function getWarningState(missingFields, lowConfidenceFields, currentFields) {
  const missing = getVisibleFields(missingFields, currentFields);
  const low = getVisibleFields(lowConfidenceFields, {});
  return {
    showWarning: Boolean(missing.length || low.length),
    warningMissingText: describeVisibleFields(missing, {}),
    warningLowText: describeVisibleFields(low, {})
  };
}

function getFormalSaveSafetyBlockText(parseResult = {}) {
  const safety = parseResult.local_parse_safety || {};
  const aiFallback = parseResult.ai_fallback || {};
  const aiStatus = aiFallback.status || 'not_requested';
  const route = parseResult.parse_route || {};
  const userResolved = evaluateUserResolvedAiState(parseResult).status === 'MANUAL_RESOLUTION_COMPLETE';
  if (route.deep_review_available && !userResolved) return '这条内容需要深度核对；未核对前不能直接保存。';
  if ((safety.status === 'NEEDS_AI' || ['ai_standard', 'ai_deep'].includes(route.decision))
    && !hasResolvedAiFallback(parseResult)
    && !userResolved) {
    if (aiStatus === 'timed_out') return '智能核对等待超时，这条先放待整理。';
    if (aiStatus === 'returned_uncertain') return '智能核对没有给出可采用的业务结果，这条先放待整理。';
    if (aiStatus === 'failed') return '智能快速核对没有完成，这条先放待整理。';
    if (aiStatus === 'skipped_no_endpoint') return '这条信息需要你多看一眼，确认后再保存。';
    return '这条信息有几处需要你确认，拿不准可以先放待整理。';
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
  return (items || [])
    .map(getMetaText)
    .filter(Boolean);
}

function hasConfirmItemValue(item) {
  return ['productName', 'spec', 'quantity', 'unit', 'unitPrice', 'priceUnit', 'totalAmount', 'itemDeliveryDate', 'itemRemark']
    .some((field) => hasFieldValue(item, field));
}

function normalizeConfirmItem(item = {}) {
  return {
    confirmationItemKey: String(item.confirmationItemKey || '').trim(),
    confirmationItemOrigin: String(item.confirmationItemOrigin || '').trim(),
    productName: item.productName || item.product_name || item.name || '',
    spec: item.spec || '',
    quantity: item.quantity || '',
    unit: normalizeUnit(item.unit || ''),
    unitPrice: item.unitPrice || item.unit_price || '',
    priceUnit: normalizeUnit(item.priceUnit || item.price_unit || item.unitPriceUnit || item.unit_price_unit || ''),
    totalAmount: item.totalAmount || item.total_amount || item.amount || '',
    itemDeliveryDate: item.itemDeliveryDate || item.deliveryDate || item.dueDate || '',
    itemRemark: item.itemRemark || item.remark || ''
  };
}

function buildItemFromLegacyFields(fields = {}) {
  const item = normalizeConfirmItem({
    productName: fields.productName,
    spec: fields.spec,
    quantity: fields.quantity,
    unit: fields.unit,
    unitPrice: fields.unitPrice,
    priceUnit: fields.priceUnit,
    totalAmount: fields.totalAmount || fields.amount,
    itemDeliveryDate: fields.itemDeliveryDate,
    itemRemark: fields.itemRemark
  });
  return hasConfirmItemValue(item) ? item : null;
}

function normalizeConfirmItems(fields = {}, options = {}) {
  const sourceItems = Array.isArray(fields.items) ? fields.items : [];
  const keyCounts = sourceItems.reduce((counts, item) => {
    const itemKey = String(item && item.confirmationItemKey || '').trim();
    if (itemKey) counts.set(itemKey, (counts.get(itemKey) || 0) + 1);
    return counts;
  }, new Map());
  const duplicatedKeys = new Set(Array.from(keyCounts.entries())
    .filter((entry) => entry[1] > 1)
    .map((entry) => entry[0]));
  const items = sourceItems
    .map(normalizeConfirmItem)
    .filter(hasConfirmItemValue);
  if (!items.length) {
    const legacyItem = buildItemFromLegacyFields(fields);
    if (legacyItem) items.push(legacyItem);
  }
  if (!items.length && options.ensureFirst) items.push(normalizeConfirmItem());
  const usedKeys = new Set();
  items.forEach((item, index) => {
    let itemKey = String(item.confirmationItemKey || '').trim();
    if (duplicatedKeys.has(itemKey)) itemKey = '';
    if (!itemKey || usedKeys.has(itemKey)) {
      itemKey = createConfirmationItemKey(item, index, usedKeys);
    }
    usedKeys.add(itemKey);
    item.confirmationItemKey = itemKey;
  });
  return items;
}

function formatDomainBlockingIssues(issues) {
  const messages = {
    AI_RESULT_UNRESOLVED: '智能核对仍有未逐项解决的内容。',
    UNTRUSTED_AI_PROVIDER_FOR_PRODUCTION: '本次智能结果来源不可用于正式保存。',
    AI_PROVIDER_IDENTITY_UNRESOLVED: '本次智能结果来源尚未确认，不能正式保存。',
    MISSING_REQUIRED_FIELD: '仍缺少必填信息。',
    LOW_CONFIDENCE_FIELD: '这个字段仍需要你亲手确认。',
    FIELD_CONFLICT: '这个字段仍有冲突，请改成最终内容。',
    ORDER_TOTAL_ITEMS_MISMATCH: '订单总额与商品明细合计不一致。',
    ORDER_ITEM_QUANTITY_REQUIRED: '数量必须填写有效正数。',
    MULTI_ITEM_LOSS: '商品明细数量不完整，请重新核对。',
    FORMAL_SAVE_BLOCKED: '这条内容当前不能保存为正式记录。',
    MIXED_BUSINESS_UNRESOLVED: '原话包含多笔不同业务，请拆开记录。'
  };
  return (Array.isArray(issues) ? issues : []).map((item) => {
    const itemLabel = Number.isInteger(item.itemIndex) ? `商品${item.itemIndex + 1}` : '';
    const field = item.itemField || item.field || '';
    const fieldLabel = field && field !== 'items' ? getFieldLabel(field) : '';
    const rawConflictMessage = item.messageParams && item.messageParams.conflictMessage;
    const conflictMessage = itemLabel && rawConflictMessage
      ? String(rawConflictMessage).replace(
        /^(?:商品\s*\d+|第\s*\d+\s*个商品)\s*[：:·、，,]?\s*/,
        ''
      )
      : rawConflictMessage;
    const detail = conflictMessage || messages[item.code] || '还有信息未满足正式保存条件。';
    return [itemLabel, fieldLabel, detail].filter(Boolean).join(' · ');
  }).filter((line, index, array) => line && array.indexOf(line) === index);
}

function hasMoneyValue(value) {
  if (!hasFieldValue({ value }, 'value')) return false;
  return Number.isFinite(Number(value));
}

function formatMoneyValue(value) {
  const number = toMoney(value);
  return Number.isInteger(number) ? String(number) : String(number);
}

function calculateConfirmItemsTotalAmount(items = []) {
  if (!items.length) return '';
  if (!items.every((item) => hasMoneyValue(item.totalAmount))) return '';
  return formatMoneyValue(items.reduce((sum, item) => sum + Number(item.totalAmount), 0));
}

function syncFirstItemToLegacyFields(fields = {}, options = {}) {
  const next = Object.assign({}, fields);
  const items = normalizeConfirmItems(next, { ensureFirst: true });
  const first = items[0] || {};
  const firstItemTotal = items.length <= 1 ? first.totalAmount : '';
  const calculatedAmount = calculateConfirmItemsTotalAmount(items) || firstItemTotal || '';
  // 老板原话里明确说出的总价，或者在确认卡里亲手改过的金额，优先级必须
  // 高于“数量 × 单价”的机器计算值。计算值只作为核对依据，不能在确认页
  // 悄悄把“总价 90”重新覆盖成 100。
  const preserveConfirmedAmount = hasFieldValue(next, 'statedAmount') || options.preserveConfirmedAmount === true;
  const confirmedAmount = preserveConfirmedAmount
    ? (next.amount || next.totalAmount || next.statedAmount || calculatedAmount || '')
    : (calculatedAmount || next.amount || next.totalAmount || '');
  next.items = items;
  next.productName = first.productName || '';
  next.spec = first.spec || '';
  next.quantity = first.quantity || '';
  next.unit = first.unit || '';
  next.unitPrice = first.unitPrice || '';
  next.priceUnit = first.priceUnit || '';
  next.calculatedAmount = calculatedAmount || next.calculatedAmount || '';
  next.amount = confirmedAmount;
  next.totalAmount = confirmedAmount;
  return next;
}

function buildConfirmItemCards(fields = {}, intent, state = {}) {
  const items = normalizeConfirmItems(fields, { ensureFirst: true });
  return items.map((item, index) => {
    const check = getCatalogCheck(state, item.productName, item.spec);
    const productSuggestions = check.item || item.productName
      ? []
      : getProductSuggestions(state, '', 6);
    const specSuggestions = check.item
      ? getSpecSuggestions(state, item.productName, '', 8)
      : [];
    return Object.assign({}, item, {
      itemKey: item.confirmationItemKey,
      indexLabel: `商品${index + 1}`,
      canRemove: items.length > 1,
      showItemDeliveryDate: intent === 'order' && Boolean(item.itemDeliveryDate),
      catalogHint: check.hint,
      catalogHintClass: ['known_product', 'known_spec'].includes(check.status) ? 'catalog-check-known' : 'catalog-check-new',
      productSuggestions,
      showProductCatalogSuggestions: productSuggestions.length > 0,
      specSuggestions,
      showSpecCatalogSuggestions: specSuggestions.length > 0
    });
  });
}

function formatLocalParseSafety(safety) {
  if (!safety || safety.status === 'SAFE_LOCAL') return [];
  const statusText = {
    NEEDS_AI: '这条信息比较复杂，请重点核对下面内容。',
    NEEDS_USER_CONFIRM: '有些信息还需要你补齐或确认。',
    NO_RECORD: '暂时没有整理成可直接保存的记录。'
  }[safety.status] || '这条记录需要你确认。';
  return uniqueFields([statusText].concat(safety.reason_texts || [])).slice(0, 6);
}

function toMoney(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return 0;
  return Number(number.toFixed(2));
}

function formatMoney(value) {
  const number = toMoney(value);
  return Number.isInteger(number) ? String(number) : String(number);
}

function buildOrderAmountSummary(fields = {}) {
  const totalAmount = fields.totalAmount || fields.amount;
  if (!hasMoneyValue(totalAmount)) return [];
  const depositAmount = hasMoneyValue(fields.depositAmount)
    ? fields.depositAmount
    : (fields.paymentKind === 'deposit' && hasMoneyValue(fields.paymentAmount) ? fields.paymentAmount : '');
  const itemCount = normalizeConfirmItems(fields).length;
  const lines = [{
    label: itemCount > 1 ? '商品合计' : '整单金额',
    value: `${formatMoney(totalAmount)}元`
  }];
  if (hasMoneyValue(depositAmount)) {
    lines.push({
      label: '定金',
      value: `${formatMoney(depositAmount)}元`
    });
    lines.push({
      label: '待收尾款',
      value: `${formatMoney(Math.max(0, toMoney(totalAmount) - toMoney(depositAmount)))}元`
    });
  }
  return lines;
}

function formatSurfaceMoneyFromCents(cents) {
  const value = Number(cents);
  if (!Number.isFinite(value)) return '';
  return (value / 100).toFixed(2);
}

function buildSurfaceRisk(field, code, options = {}) {
  const message = code === 'ORDER_TOTAL_ITEMS_MISMATCH'
    ? '总金额与商品明细合计不一致'
    : (surfaceRiskMessages[field] || `请确认${getFieldLabel(field) || '这项信息'}`);
  return {
    code: String(code || 'FIELD_REQUIRES_CONFIRMATION'),
    errorText: message,
    field,
    itemKey: String(options.itemKey || ''),
    message,
    riskText: message,
    text: message
  };
}

function buildConfirmationSurfaceProjection({
  activeQuestion,
  confirmItems,
  domainPreflight,
  fields,
  intent,
  parseResult,
  safeBlocked
}) {
  const riskByField = {};
  const riskByItem = {};
  const unplacedBlockingLines = [];
  const itemsByKey = new Map((confirmItems || []).map((item) => [String(item.itemKey || ''), item]));
  const itemFields = new Set(MANUAL_ITEM_FIELDS);
  const placeFieldRisk = (field, code) => {
    if (!field || riskByField[field]) return;
    riskByField[field] = buildSurfaceRisk(field, code);
  };
  const placeItemRisk = (itemKey, field, code) => {
    const key = String(itemKey || '');
    if (!key || !field || !itemsByKey.has(key)) return false;
    if (!riskByItem[key]) riskByItem[key] = {};
    if (!riskByItem[key][field]) {
      riskByItem[key][field] = buildSurfaceRisk(field, code, { itemKey: key });
    }
    return true;
  };

  if (activeQuestion && activeQuestion.target) {
    const target = activeQuestion.target;
    if (target.itemKey) placeItemRisk(target.itemKey, target.field, 'ACTIVE_QUESTION');
    else placeFieldRisk(target.field, 'ACTIVE_QUESTION');
  }

  const blockingIssues = domainPreflight && Array.isArray(domainPreflight.blockingIssues)
    ? domainPreflight.blockingIssues
    : [];
  blockingIssues.forEach((issue) => {
    const field = String(issue.itemField || issue.field || '');
    const itemKey = String(issue.itemKey || '');
    if (itemKey && itemFields.has(field) && placeItemRisk(itemKey, field, issue.code)) return;
    if (surfacePlacedRootFields.has(field)) {
      placeFieldRisk(field, issue.code);
      return;
    }
    if (field === 'productName' && itemKey && placeItemRisk(itemKey, field, issue.code)) return;
    if (!['AI_RESULT_UNRESOLVED', 'FORMAL_SAVE_BLOCKED'].includes(issue.code)) {
      unplacedBlockingLines.push(
        surfaceUnplacedRiskMessages[field] || '请确认相关信息后再保存'
      );
    }
  });

  const amountMismatch = blockingIssues.find((issue) => issue.code === 'ORDER_TOTAL_ITEMS_MISMATCH');
  const canonicalTotalCents = amountMismatch
    && amountMismatch.messageParams
    && amountMismatch.messageParams.canonicalTotalCents;
  const canonicalTotalValue = formatSurfaceMoneyFromCents(canonicalTotalCents);
  if (amountMismatch) {
    riskByField.amount = buildSurfaceRisk('amount', 'ORDER_TOTAL_ITEMS_MISMATCH');
  }
  const amountRisk = riskByField.amount || null;
  const amountSurface = {
    canonicalTotalText: amountMismatch && canonicalTotalValue
      ? `明细合计：${canonicalTotalValue}元`
      : '',
    canonicalTotalValue,
    errorText: amountRisk ? amountRisk.message : '',
    hasError: Boolean(amountRisk),
    message: amountRisk ? amountRisk.message : '',
    riskText: amountRisk ? amountRisk.message : '',
    statedValue: String(fields.amount || fields.totalAmount || '')
  };
  if (amountRisk) riskByField.amount = Object.assign({}, amountRisk, amountSurface);

  const originalText = String(parseResult.raw_text || parseResult.original_text || '');
  return {
    amountSurface,
    originalTextExpanded: false,
    riskByField,
    riskByItem,
    safeBlockedMessage: safeBlocked ? '这笔信息暂时无法确认，请重新输入原话' : '',
    showSurfaceGlobalRisk: unplacedBlockingLines.length > 0 && !activeQuestion,
    surfaceConfirmTitle: surfaceConfirmTitles[intent] || surfaceConfirmTitles.unknown,
    surfaceGlobalRiskText: unplacedBlockingLines[0] || '',
    surfaceOriginalText: originalText
  };
}

function getRemainingAmount(receivable) {
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

function findCustomerForFields(state, fields) {
  const customers = state.customers || [];
  if (fields.customerId) {
    const byId = customers.find((customer) => customer.id === fields.customerId);
    if (byId && (!fields.customerName || includesCustomerName(byId, fields.customerName))) return byId;
  }
  if (!fields.customerName) return null;
  return customers.find((customer) => includesCustomerName(customer, fields.customerName)) || null;
}

function getCustomerNameById(state, customerId) {
  const customer = (state.customers || []).find((item) => item.id === customerId);
  return customer ? customer.name : '';
}

function getCustomerById(state, customerId) {
  return (state.customers || []).find((item) => item.id === customerId && !item.mergedInto);
}

function customerNeedsMatch(operation) {
  return ['create_quotation', 'create_order', 'create_receivable', 'create_receivable_with_payment', 'record_payment', 'record_order_deposit', 'create_todo'].includes(operation);
}

function hasCustomerDiscriminator(fields) {
  return Boolean(fields.phone || fields.company || fields.region || fields.customerNote || fields.wechatRemark);
}

function emptyCustomerMatchState(fields) {
  return {
    fields,
    showCustomerMatchBox: false,
    showCustomerPicker: false,
    showCustomerDisambiguationField: false,
    showCustomerHistoryConfirm: false,
    customerMatchText: '',
    customerMatchWarningText: '',
    customerHistoryTitle: '',
    customerHistoryLines: [],
    customerMatchRange: [],
    customerMatchOptions: [],
    selectedCustomerIndex: -1,
    selectedCustomerLabel: '',
    customerMatchBlocksSave: false
  };
}

function getCustomerBusinessHistory(state, customerId, operation) {
  if (!customerId) return { title: '', lines: [], requiresConfirm: false };
  const quotations = (state.quotations || []).filter((item) => item.customerId === customerId);
  const orders = (state.orders || []).filter((item) => item.customerId === customerId);
  const receivables = (state.receivables || []).filter((item) => item.customerId === customerId && !['已结清', '坏账'].includes(item.status));
  if (operation === 'create_order' && orders.length) {
    return {
      title: `这个客户已有 ${orders.length} 笔订单`,
      lines: orders.slice(0, 3).map((item) => `${getItemsSummary(item) || '未填产品'}，交期 ${item.requiredDeliveryDate || '-'}`),
      requiresConfirm: true
    };
  }
  if (operation === 'create_quotation' && quotations.length) {
    return {
      title: `这个客户已有 ${quotations.length} 条报价`,
      lines: quotations.slice(0, 3).map((item) => `${getItemsSummary(item) || '未填产品'}，报价 ${item.totalAmount || '-'}元，状态 ${item.status || '-'}`),
      requiresConfirm: true
    };
  }
  if (operation === 'create_receivable' && receivables.length) {
    return {
      title: `这个客户已有 ${receivables.length} 笔未结清待收款 / 欠款`,
      lines: receivables.slice(0, 3).map((item) => `待收 ${item.amount || '-'}元，到期 ${item.dueDate || '-'}`),
      requiresConfirm: true
    };
  }
  return { title: '', lines: [], requiresConfirm: false };
}

function withCustomerHistoryState(baseState, state, fields, operation) {
  const nextState = Object.assign({}, baseState);
  if (fields.forceNewCustomer) {
    nextState.showCustomerHistoryConfirm = false;
    nextState.customerHistoryTitle = '';
    nextState.customerHistoryLines = [];
    return nextState;
  }
  const history = getCustomerBusinessHistory(state, fields.customerId, operation);
  if (!history.requiresConfirm) return nextState;
  nextState.customerHistoryTitle = history.title;
  nextState.customerHistoryLines = history.lines;
  if (!fields.customerHistoryConfirmed) {
    nextState.showCustomerHistoryConfirm = false;
    nextState.customerMatchWarningText = `${history.title}。当前内容会按新增业务保存；若原话指旧记录，请改为选择旧记录。`;
    // 单纯存在历史业务不是保存风险；更新或历史指代由统一领域预检判断。
    nextState.customerMatchBlocksSave = false;
  }
  return nextState;
}

function buildCustomerMatchState(state, fields, operation) {
  const nextFields = Object.assign({}, fields);
  if (!customerNeedsMatch(operation) || !nextFields.customerName) {
    return emptyCustomerMatchState(nextFields);
  }

  const matches = findCustomerMatches(state, nextFields);
  const selectedCustomer = nextFields.customerId ? getCustomerById(state, nextFields.customerId) : null;
  const uniqueMatchKind = matches.length === 1
    ? getCustomerNameMatchKind(matches[0], nextFields.customerName)
    : 'NONE';
  if (selectedCustomer && nextFields.customerName && !includesCustomerName(selectedCustomer, nextFields.customerName)) {
    delete nextFields.customerId;
  }

  if (matches.length === 1 && uniqueMatchKind === 'EXACT'
    && !nextFields.forceNewCustomer && !nextFields.customerId) {
    nextFields.customerId = matches[0].id;
  }

  if (matches.length === 1 && !nextFields.forceNewCustomer
    && (uniqueMatchKind === 'EXACT' || nextFields.customerSelectionConfirmed === true)) {
    return withCustomerHistoryState(Object.assign(emptyCustomerMatchState(nextFields), {
      showCustomerMatchBox: true,
      customerMatchText: `已匹配已有客户：${getCustomerDisplay(matches[0])}`
    }), state, nextFields, operation);
  }

  if (matches.length === 0 && !nextFields.forceNewCustomer) {
    return emptyCustomerMatchState(nextFields);
  }

  const customerMatchOptions = matches.map((customer, index) => ({
    id: customer.id,
    label: `${getCustomerDisplay(customer)} · 第${index + 1}个`
  })).concat({
    id: NEW_CUSTOMER_OPTION_ID,
    label: `新建另一个${nextFields.customerName}`
  });
  const selectedCustomerIndex = nextFields.forceNewCustomer
    ? customerMatchOptions.length - 1
    : customerMatchOptions.findIndex((option) => option.id === nextFields.customerId);
  const creatingNew = selectedCustomerIndex === customerMatchOptions.length - 1;
  const needsDiscriminator = creatingNew && !hasCustomerDiscriminator(nextFields);
  let customerMatchWarningText = '';
  if (selectedCustomerIndex < 0) {
    customerMatchWarningText = `系统里有多个${nextFields.customerName}，请选择这笔业务关联哪一个客户，或者新建一个客户。`;
  } else if (needsDiscriminator) {
    customerMatchWarningText = '如果这是另一个新客户，请补手机号或客户区分备注，避免以后两个客户看不出来。';
  }

  return withCustomerHistoryState({
    fields: nextFields,
    showCustomerMatchBox: true,
    showCustomerPicker: true,
    showCustomerDisambiguationField: creatingNew,
    showCustomerHistoryConfirm: false,
    customerMatchText: matches.length === 1
      ? `找到称呼相近的客户：${getCustomerDisplay(matches[0])}，请确认是否为同一人。`
      : `找到 ${matches.length} 个同名或近似客户，请确认这笔业务属于谁。`,
    customerMatchWarningText,
    customerHistoryTitle: '',
    customerHistoryLines: [],
    customerMatchRange: customerMatchOptions.map((option) => option.label),
    customerMatchOptions,
    selectedCustomerIndex,
    selectedCustomerLabel: selectedCustomerIndex >= 0 ? customerMatchOptions[selectedCustomerIndex].label : '',
    customerMatchBlocksSave: Boolean(customerMatchWarningText)
  }, state, nextFields, operation);
}

function mergePresentFields(base, patch) {
  const merged = Object.assign({}, base);
  Object.keys(patch || {}).forEach((key) => {
    if (hasFieldValue(patch, key)) merged[key] = patch[key];
  });
  return merged;
}

function hydrateQuotationFields(state, fields) {
  if (!fields.quotationId) return null;
  const quotation = (state.quotations || []).find((item) => item.id === fields.quotationId);
  if (!quotation) return null;
  return mergePresentFields({
    quotationId: quotation.id,
    customerId: quotation.customerId,
    customerName: getCustomerNameById(state, quotation.customerId),
    productName: quotation.productName || '',
    spec: quotation.spec || '',
    quantity: quotation.quantity || '',
    unit: quotation.unit || '',
    unitPrice: quotation.unitPrice || '',
    priceUnit: quotation.priceUnit || '',
    items: getRecordItems(quotation),
    amount: quotation.totalAmount || '',
    followupDays: quotation.followupDays || '',
    dueDate: quotation.deliveryDate || '',
    quoteDate: quotation.quoteDate || '',
    remark: quotation.remark || ''
  }, fields);
}

function hydrateOrderFields(state, fields) {
  if (!fields.orderId) return null;
  const order = (state.orders || []).find((item) => item.id === fields.orderId);
  if (!order) return null;
  return mergePresentFields({
    orderId: order.id,
    quotationId: order.quotationId || '',
    customerId: order.customerId,
    customerName: getCustomerNameById(state, order.customerId),
    productName: order.productName || '',
    spec: order.spec || '',
    quantity: order.quantity || '',
    unit: order.unit || '',
    unitPrice: order.unitPrice || '',
    priceUnit: order.priceUnit || '',
    items: getRecordItems(order),
    amount: order.totalAmount || '',
    dueDate: order.requiredDeliveryDate || '',
    remark: order.remark || ''
  }, fields);
}

function normalizeFollowupDays(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_QUOTATION_FOLLOWUP_DAYS;
  return Math.min(FOLLOWUP_DAY_VALUES[FOLLOWUP_DAY_VALUES.length - 1], Math.max(1, Math.round(number)));
}

function getFollowupDayIndex(value) {
  const days = normalizeFollowupDays(value);
  const index = FOLLOWUP_DAY_VALUES.indexOf(days);
  return index >= 0 ? index : DEFAULT_QUOTATION_FOLLOWUP_DAYS - 1;
}

function ensureQuotationFollowupFields(fields, operation) {
  if (!['create_quotation', 'update_quotation'].includes(operation)) return fields;
  const nextFields = Object.assign({}, fields);
  const hasTypedDays = hasFieldValue(nextFields, 'followupDays');
  if (hasTypedDays) {
    const days = normalizeFollowupDays(nextFields.followupDays);
    nextFields.followupDays = String(days);
    nextFields.dueDate = addDays(today(), days);
    return nextFields;
  }
  if (nextFields.dueDate) {
    const days = diffDays(nextFields.dueDate, today());
    nextFields.followupDays = String(days > 0 ? days : '');
    return nextFields;
  }
  return nextFields;
}

function formatReceivableOption(receivable) {
  return `待收${formatMoney(receivable.amount)}元，剩余${formatMoney(receivable.remainingAmount)}元，到期${receivable.dueDate || '-'}`;
}

function productMatches(inputProduct, orderProduct) {
  const input = String(inputProduct || '').replace(/\s+/g, '');
  const current = String(orderProduct || '').replace(/\s+/g, '');
  if (!input || !current) return true;
  return input === current || input.includes(current) || current.includes(input);
}

function getOrderRemainingSettlement(state, order) {
  const receivable = (state.receivables || []).find((item) => item.orderId === order.id);
  if (receivable) {
    return Math.max(0, toMoney(receivable.amount) - toMoney(receivable.paidAmount));
  }
  return Math.max(0, toMoney(order.totalAmount) - getOrderDepositAmount(state, order.id));
}

function formatOrderOption(state, order) {
  return `${order.productName || '未填产品'}，${order.status || '-'}，交期${order.requiredDeliveryDate || '-'}，待收尾款${formatMoney(getOrderRemainingSettlement(state, order))}元`;
}

function emptyGenericOrderSelectionState(fields) {
  return {
    fields,
    orderCandidates: [],
    orderOptions: [],
    orderRange: [],
    selectedOrderId: fields.orderId || '',
    selectedOrder: null,
    selectedOrderIndex: -1,
    selectedOrderLabel: '',
    orderSelectionRequired: false,
    orderSelectionReason: '',
    orderSelectionBaseFields: null,
    showGenericOrderSelection: false,
    showGenericOrderPicker: false
  };
}

function buildOrderCandidateProjection(state, order) {
  const items = getRecordItems(order);
  return {
    id: order.id,
    orderId: order.id,
    customerId: order.customerId,
    customerDisplayName: getCustomerNameById(state, order.customerId) || '未命名客户',
    productSummary: getItemsSummary(order) || order.productName || '未填产品',
    itemCount: items.length || (order.productName ? 1 : 0),
    orderAmount: order.totalAmount || '',
    status: order.status || '',
    dueDate: order.requiredDeliveryDate || '',
    createdAt: order.createdAt || ''
  };
}

function buildGenericOrderSelectionState(state, fields, operation, domainPreflight) {
  const nextFields = Object.assign({}, fields);
  if (operation === 'record_order_deposit') return emptyGenericOrderSelectionState(nextFields);

  const preflightCandidates = (((domainPreflight || {}).candidates || {}).orderCandidates || []);
  const allowedIds = new Set(preflightCandidates.map((item) => String(item.id || '')).filter(Boolean));
  const orderCandidates = (state.orders || [])
    .filter((order) => allowedIds.has(String(order.id || '')))
    .filter((order) => activeOrderStatuses.includes(order.status))
    .map((order) => buildOrderCandidateProjection(state, order));
  const selectedOrderId = String(nextFields.orderId || '');
  const selectedOrder = orderCandidates.find((item) => item.id === selectedOrderId) || null;
  const requiredSelections = (domainPreflight && domainPreflight.requiredSelections) || [];
  const blockingIssues = (domainPreflight && domainPreflight.blockingIssues) || [];
  const orderSelectionRequired = requiredSelections.includes('orderId');
  const orderActionRequired = blockingIssues.some((item) => item.requiredAction === 'SELECT_ORDER');
  const operationSupportsOptionalOrder = ['create_receivable', 'create_receivable_with_payment'].includes(operation);
  const showGenericOrderSelection = orderSelectionRequired
    || orderActionRequired
    || Boolean(selectedOrderId)
    || (operationSupportsOptionalOrder && orderCandidates.length > 0);
  let orderSelectionReason = '';
  if (orderSelectionRequired) {
    orderSelectionReason = orderCandidates.length > 1
      ? '找到多笔可关联订单，请选择原话指的是哪一单。'
      : '请确认这笔业务关联哪一张订单。';
  } else if (orderActionRequired) {
    orderSelectionReason = '当前订单关系不安全，请重新选择同一客户的有效订单。';
  } else if (operationSupportsOptionalOrder) {
    orderSelectionReason = '如果这笔待收属于已有订单，可以在这里关联；不关联不会自动猜订单。';
  }
  if (showGenericOrderSelection && !orderCandidates.length) {
    orderSelectionReason = '没有找到可选择的同客户有效订单，当前不能完成订单关联。';
  }
  const orderOptions = orderCandidates.map((item) => ({
    id: item.id,
    label: `${item.customerDisplayName} · ${item.productSummary} · ${item.status || '-'} · 交期${item.dueDate || '-'}`
  }));
  const selectedOrderIndex = orderOptions.findIndex((item) => item.id === selectedOrderId);

  return {
    fields: nextFields,
    orderCandidates,
    orderOptions,
    orderRange: orderOptions.map((item) => item.label),
    selectedOrderId,
    selectedOrder,
    selectedOrderIndex,
    selectedOrderLabel: selectedOrderIndex >= 0 ? orderOptions[selectedOrderIndex].label : '',
    orderSelectionRequired,
    orderSelectionReason,
    orderSelectionBaseFields: null,
    showGenericOrderSelection,
    showGenericOrderPicker: orderOptions.length > 0
  };
}

function copyOrderSelectionBaseFields(fields) {
  const base = Object.assign({}, fields);
  if (Array.isArray(fields.items)) {
    base.items = fields.items.map((item) => Object.assign({}, item));
  }
  delete base.orderId;
  delete base.orderSelectionConfirmed;
  return base;
}

function retainOrderCandidateChoices(state, confirmationState, priorCandidates, selectedId) {
  const currentCustomerId = String((confirmationState.fields || {}).customerId || '');
  const retained = (priorCandidates || [])
    .map((candidate) => (state.orders || []).find((order) => order.id === candidate.id))
    .filter(Boolean)
    .filter((order) => activeOrderStatuses.includes(order.status))
    .filter((order) => !currentCustomerId || order.customerId === currentCustomerId)
    .map((order) => buildOrderCandidateProjection(state, order));
  if (!retained.length) return confirmationState;
  const orderOptions = retained.map((item) => ({
    id: item.id,
    label: `${item.customerDisplayName} · ${item.productSummary} · ${item.status || '-'} · 交期${item.dueDate || '-'}`
  }));
  const selectedOrderIndex = orderOptions.findIndex((item) => item.id === selectedId);
  return Object.assign({}, confirmationState, {
    orderCandidates: retained,
    orderOptions,
    orderRange: orderOptions.map((item) => item.label),
    selectedOrderId: selectedId,
    selectedOrder: retained.find((item) => item.id === selectedId) || null,
    selectedOrderIndex,
    selectedOrderLabel: selectedOrderIndex >= 0 ? orderOptions[selectedOrderIndex].label : '',
    showGenericOrderSelection: true,
    showGenericOrderPicker: true
  });
}

function rebuildAfterGenericOrderFieldEdit(state, pageData, baseResult, intent, nextBaseFields) {
  const selectedId = String(pageData.selectedOrderId || '');
  if (!selectedId || !pageData.orderSelectionBaseFields) {
    return buildConfirmationState(state, baseResult, intent, nextBaseFields);
  }
  const baseFields = copyOrderSelectionBaseFields(nextBaseFields);
  const fields = Object.assign({}, baseFields, {
    orderId: selectedId,
    orderSelectionConfirmed: true
  });
  const confirmationState = retainOrderCandidateChoices(
    state,
    buildConfirmationState(state, baseResult, intent, fields),
    pageData.orderCandidates,
    selectedId
  );
  confirmationState.orderSelectionBaseFields = baseFields;
  return confirmationState;
}

function buildGenericQuotationSelectionState(fields, operation, domainPreflight) {
  const nextFields = Object.assign({}, fields);
  const preflightCandidates = (((domainPreflight || {}).candidates || {})
    .quotationSelectionCandidates || []);
  const quotationCandidates = preflightCandidates.map((item) => ({
    id: String(item.id || item.quotationId || ''),
    quotationId: String(item.quotationId || item.id || ''),
    customerId: String(item.customerId || ''),
    customerDisplayName: String(item.customerDisplayName || ''),
    productSummary: String(item.productSummary || ''),
    itemCount: Number(item.itemCount || 0),
    quotationAmount: item.quotationAmount || '',
    status: String(item.status || ''),
    quoteDate: String(item.quoteDate || ''),
    validUntil: String(item.validUntil || ''),
    convertedOrderId: String(item.convertedOrderId || ''),
    createdAt: String(item.createdAt || ''),
    selectionEligible: item.selectionEligible === true,
    selectionBlockingCodes: Array.isArray(item.selectionBlockingCodes)
      ? item.selectionBlockingCodes.slice()
      : []
  })).filter((item) => item.id);
  const selectedQuotationId = String(nextFields.quotationId || '');
  const selectedQuotation = quotationCandidates
    .find((item) => item.id === selectedQuotationId) || null;
  const requiredSelections = (domainPreflight && domainPreflight.requiredSelections) || [];
  const blockingIssues = (domainPreflight && domainPreflight.blockingIssues) || [];
  const quotationSelectionRequired = requiredSelections.includes('quotationId');
  const quotationActionRequired = blockingIssues
    .some((item) => item.requiredAction === 'SELECT_QUOTATION');
  const quotationRelationConflict = blockingIssues
    .some((item) => item.code === 'QUOTATION_ORDER_RELATION_CONFLICT');
  const operationSupportsQuotation = ['update_quotation', 'create_order'].includes(operation);
  const showGenericQuotationSelection = operationSupportsQuotation && (
    quotationSelectionRequired
    || quotationActionRequired
    || Boolean(selectedQuotationId)
  );
  let quotationSelectionReason = '';
  if (quotationRelationConflict) {
    quotationSelectionReason = '报价与订单关系存在数据冲突，请先核对原记录。';
  } else if (quotationSelectionRequired) {
    quotationSelectionReason = quotationCandidates.length > 1
      ? '找到多张可用报价，请选择原话指的是哪一张。'
      : '请确认这次业务关联哪一张报价。';
  } else if (quotationActionRequired) {
    quotationSelectionReason = '当前报价关系不安全，请重新选择同一客户的有效报价。';
  } else if (selectedQuotationId) {
    quotationSelectionReason = '已关联报价；如需更换，请重新选择。';
  }
  if (showGenericQuotationSelection && !quotationCandidates.length) {
    quotationSelectionReason = '没有找到可选择的同客户有效报价，当前不能完成报价关联。';
  }
  const quotationOptions = quotationCandidates.map((item) => ({
    id: item.id,
    label: `${item.customerDisplayName} · ${item.productSummary || '未填产品'} · ${item.status || '-'} · 报价${item.quotationAmount || '-'}元`
  }));
  const selectedQuotationIndex = quotationOptions
    .findIndex((item) => item.id === selectedQuotationId);

  return {
    fields: nextFields,
    quotationCandidates,
    quotationOptions,
    quotationRange: quotationOptions.map((item) => item.label),
    selectedQuotationId,
    selectedQuotation,
    selectedQuotationIndex,
    selectedQuotationLabel: selectedQuotationIndex >= 0
      ? quotationOptions[selectedQuotationIndex].label
      : '',
    quotationSelectionRequired,
    quotationSelectionReason,
    quotationSelectionConfirmed: Boolean(
      selectedQuotation && nextFields.quotationSelectionConfirmed === true
    ),
    quotationSelectionBaseFields: null,
    quotationSelectionRootFields: null,
    showGenericQuotationSelection,
    showGenericQuotationPicker: quotationOptions.length > 0
  };
}

function copyQuotationSelectionBaseFields(fields) {
  const base = Object.assign({}, fields);
  if (Array.isArray(fields.items)) {
    base.items = fields.items.map((item) => Object.assign({}, item));
  }
  delete base.quotationId;
  delete base.quotationSelectionConfirmed;
  return base;
}

const QUOTATION_ITEM_REMOVED = '__quotationItemRemoved';

function mergeQuotationSelectionDraftFields(state, baseFields, quotationId) {
  const selectedId = String(quotationId || '');
  const historicalFields = hydrateQuotationFields(state, {
    quotationId: selectedId
  });
  const patchFields = copyQuotationSelectionBaseFields(baseFields || {});
  if (!historicalFields) {
    return Object.assign({}, patchFields, {
      quotationId: selectedId,
      quotationSelectionConfirmed: true
    });
  }

  const historicalItems = normalizeConfirmItems(historicalFields);
  const rawPatchItems = Array.isArray(patchFields.items)
    ? patchFields.items.map((item) => Object.assign({}, item))
    : [];
  const itemCount = Math.max(historicalItems.length, rawPatchItems.length);
  const items = [];
  for (let index = 0; index < itemCount; index += 1) {
    const rawPatchItem = rawPatchItems[index] || {};
    if (rawPatchItem[QUOTATION_ITEM_REMOVED] === true) continue;
    const historicalItem = historicalItems[index] || {};
    const patchItem = normalizeConfirmItem(rawPatchItem);
    const item = mergePresentFields(historicalItem, patchItem);
    if (hasConfirmItemValue(item)) items.push(item);
  }

  const merged = mergePresentFields(historicalFields, patchFields);
  if (items.length) merged.items = items;
  merged.quotationId = selectedId;
  merged.quotationSelectionConfirmed = true;
  return merged;
}

function rebuildAfterQuotationFieldEdit(state, pageData, baseResult, intent, nextBaseFields) {
  const selectedId = String(pageData.selectedQuotationId || '');
  if (!selectedId || !pageData.quotationSelectionBaseFields) {
    return buildConfirmationState(state, baseResult, intent, nextBaseFields);
  }
  const baseFields = copyQuotationSelectionBaseFields(nextBaseFields);
  const fields = mergeQuotationSelectionDraftFields(state, baseFields, selectedId);
  const confirmationState = buildConfirmationState(state, baseResult, intent, fields);
  const stillSafe = (confirmationState.quotationCandidates || [])
    .some((item) => item.id === selectedId);
  if (!stillSafe) {
    return buildConfirmationState(state, baseResult, intent, baseFields);
  }
  confirmationState.quotationSelectionBaseFields = baseFields;
  confirmationState.quotationSelectionRootFields = pageData.quotationSelectionRootFields
    ? copyQuotationSelectionBaseFields(pageData.quotationSelectionRootFields)
    : copyQuotationSelectionBaseFields(baseFields);
  return confirmationState;
}

function getFieldVisibility(intent, operation, fields = {}) {
  const quoteOrOrder = ['quotation', 'order'].includes(intent);
  const todo = ['todo', 'dunning'].includes(intent);
  const createReceivable = operation === 'create_receivable';
  const recordPayment = ['record_payment', 'create_receivable_with_payment'].includes(operation);
  const recordOrderDeposit = operation === 'record_order_deposit';
  const quoteOperation = ['create_quotation', 'update_quotation'].includes(operation);
  const editableBusiness = operation !== 'pending' && intent !== 'unknown';
  const todoHasProductInfo = todo && Boolean(fields.productName || fields.quantity || fields.unit || fields.unitPrice || fields.amount);
  return {
    showCustomerFields: editableBusiness,
    showPhoneField: ['create_quotation', 'create_order', 'update_quotation', 'update_order', 'create_receivable', 'create_receivable_with_payment', 'record_payment', 'record_order_deposit', 'create_todo'].includes(operation),
    showTodoTitleField: todo,
    showFollowupDaysField: quoteOperation,
    showItemList: quoteOrOrder,
    showProductField: recordOrderDeposit || todoHasProductInfo,
    showQuantityFields: todo && Boolean(fields.quantity || fields.unit),
    showPriceFields: todo && Boolean(fields.unitPrice || fields.amount),
    showAmountField: createReceivable,
    showPaymentAmountField: recordPayment || recordOrderDeposit || (intent === 'order' && Boolean(fields.paymentAmount || fields.depositAmount)),
    showRemainingAmountField: operation === 'create_receivable_with_payment',
    showDueDateField: ['create_order', 'update_order', 'create_receivable', 'record_payment', 'create_todo'].includes(operation),
    showRemarkField: editableBusiness,
    showGenericDraft: !editableBusiness
  };
}

function getGuessedSummary(fields) {
  return Object.keys(fields || {})
    .filter((field) => field !== 'intent' && fields[field] && getFieldLabel(field) !== field)
    .map((field) => `${getFieldLabel(field)}：${fields[field]}`);
}

function normalizePaymentMissing(missingFields, fields, operation) {
  return filterRelevantWarningFields((missingFields || [])
    .map((field) => (field === 'amount' && operation === 'record_payment' ? 'paymentAmount' : field))
    .filter((field) => {
      if (['create_receivable_with_payment', 'record_payment'].includes(operation) && field === 'receivableId') return false;
      return !hasFieldValue(fields, field);
    }), 'payment', operation);
}

function normalizeOrderDepositMissing(missingFields, fields) {
  return filterRelevantWarningFields((missingFields || [])
    .map((field) => (field === 'depositAmount' ? 'paymentAmount' : field))
    .filter((field) => field !== 'orderId' && !hasFieldValue(fields, field)), 'payment', 'record_order_deposit');
}

function buildOrderDepositState(state, fields, aiMissingFields, lowConfidenceFields) {
  const nextFields = Object.assign({}, fields);
  let low = uniqueFields(lowConfidenceFields)
    .map((field) => (field === 'depositAmount' ? 'paymentAmount' : field));
  const explicitlyUnlinked = nextFields.orderId === UNLINKED_ORDER_OPTION_ID
    || nextFields.allowUnlinkedOrderDeposit === true;
  const orderSelectionConfirmed = nextFields.orderSelectionConfirmed === true;
  if (nextFields.orderId === UNLINKED_ORDER_OPTION_ID) {
    delete nextFields.orderId;
    nextFields.allowUnlinkedOrderDeposit = true;
  }
  if (!hasFieldValue(nextFields, 'paymentAmount') && hasFieldValue(nextFields, 'depositAmount')) {
    nextFields.paymentAmount = nextFields.depositAmount;
  }
  if (!hasFieldValue(nextFields, 'depositAmount') && hasFieldValue(nextFields, 'paymentAmount')) {
    nextFields.depositAmount = nextFields.paymentAmount;
  }

  const customer = findCustomerForFields(state, nextFields);
  if (customer) {
    nextFields.customerId = customer.id;
    if (explicitlyUnlinked) nextFields.unlinkedOrderDepositCustomerId = customer.id;
  }
  const orders = customer
    ? (state.orders || [])
      .filter((item) => item.customerId === customer.id)
      .filter((item) => activeOrderStatuses.includes(item.status))
      .filter((item) => productMatches(nextFields.productName, item.productName))
    : [];

  const selected = orders.find((item) => item.id === nextFields.orderId) || null;
  if (!explicitlyUnlinked && nextFields.orderId && !selected) {
    delete nextFields.orderId;
    delete nextFields.orderSelectionConfirmed;
  }
  const matchedOrderOptions = orders.map((item) => ({
    id: item.id,
    label: formatOrderOption(state, item)
  }));
  const orderOptions = orders.length
    ? [{ id: UNLINKED_ORDER_OPTION_ID, label: '不关联订单（仅记一笔定金）' }].concat(matchedOrderOptions)
    : matchedOrderOptions;
  const orderRange = orderOptions.map((item) => item.label);
  const selectedIndex = explicitlyUnlinked
    ? orderOptions.findIndex((item) => item.id === UNLINKED_ORDER_OPTION_ID)
    : orderOptions.findIndex((item) => selected && item.id === selected.id);
  const paymentAmount = toMoney(nextFields.paymentAmount);
  const orderDepositPreview = [];
  let orderDepositWarningText = '';

  if (explicitlyUnlinked) {
    low = low.filter((field) => field !== 'orderId');
    delete nextFields.orderId;
    orderDepositPreview.push(`本次定金：${formatMoney(paymentAmount)}元`);
    orderDepositPreview.push('将仅记录一笔未关联订单定金，不会挂到任何订单或自动核销。');
    orderDepositWarningText = '已明确选择不关联订单；后续如需核对，请在记录详情中查看原始内容。';
  } else if (!orders.length) {
    delete nextFields.unlinkedOrderDepositCustomerId;
    orderDepositWarningText = customer
      ? '没有找到可关联订单，确认后会先保存为未关联订单定金，不会挂错订单。'
      : '请先确认客户；确认后可先保存为未关联订单定金。';
  } else if (!selected || !orderSelectionConfirmed) {
    delete nextFields.unlinkedOrderDepositCustomerId;
    low.push('orderId');
    orderDepositWarningText = selected
      ? '已匹配到订单；请在下方点选确认，或选择不关联订单。'
      : (orders.length === 1
        ? '已找到一笔可关联订单；请确认定金属于这单，或选择不关联订单。'
        : '这个客户有多笔进行中订单；请先选择定金属于哪一单，避免挂错订单。');
  } else {
    delete nextFields.unlinkedOrderDepositCustomerId;
    low = low.filter((field) => field !== 'orderId');
    const paidBefore = getOrderDepositAmount(state, selected.id);
    const paidAfter = toMoney(paidBefore + paymentAmount);
    const remainingAfter = Math.max(0, toMoney(toMoney(selected.totalAmount) - paidAfter));
    orderDepositPreview.push(`匹配订单：${selected.productName || '未填产品'}，交期${selected.requiredDeliveryDate || '-'}`);
    orderDepositPreview.push(`订单金额：${formatMoney(selected.totalAmount)}元`);
    orderDepositPreview.push(`定金前：已收${formatMoney(paidBefore)}元，待收尾款${formatMoney(getOrderRemainingSettlement(state, selected))}元`);
    orderDepositPreview.push(`本次定金：${formatMoney(paymentAmount)}元`);
    orderDepositPreview.push(`保存后：已收定金${formatMoney(paidAfter)}元，待收尾款${formatMoney(remainingAfter)}元`);
    if (paymentAmount > getOrderRemainingSettlement(state, selected)) {
      low.push('paymentAmount');
      orderDepositWarningText = '本次定金大于订单剩余待结算金额，请确认是否录错。';
    }
  }

  const missing = uniqueFields(normalizeOrderDepositMissing(aiMissingFields, nextFields)
    .concat(getMissing('payment', nextFields, 'record_order_deposit')));

  return {
    fields: nextFields,
    operation: 'record_order_deposit',
    missingFields: missing,
    lowConfidenceFields: uniqueFields(low),
    orderDepositPreview,
    orderDepositWarningText,
    orderOptions,
    orderRange,
    selectedOrderIndex: selectedIndex,
    selectedOrderLabel: selectedIndex >= 0 ? orderRange[selectedIndex] : ''
  };
}

function buildPaymentState(state, fields, aiMissingFields, lowConfidenceFields, suggestedOperation) {
  const nextFields = Object.assign({}, fields);
  const low = uniqueFields(lowConfidenceFields)
    .map((field) => (field === 'amount' ? 'paymentAmount' : field))
    .filter((field) => field !== 'receivableId');
  const explicitlyUnlinked = nextFields.receivableId === UNLINKED_RECEIVABLE_OPTION_ID
    || nextFields.allowUnlinkedPayment === true;
  const receivableSelectionConfirmed = nextFields.receivableSelectionConfirmed === true;
  if (nextFields.receivableId === UNLINKED_RECEIVABLE_OPTION_ID) {
    delete nextFields.receivableId;
    nextFields.allowUnlinkedPayment = true;
  }
  const hadPaymentAmount = hasFieldValue(nextFields, 'paymentAmount');
  if (!hadPaymentAmount && hasFieldValue(nextFields, 'amount')) {
    nextFields.paymentAmount = nextFields.amount;
  }
  const customer = findCustomerForFields(state, nextFields);
  const receivables = customer
    ? (state.receivables || [])
      .filter((item) => item.customerId === customer.id && activeReceivableStatuses.includes(item.status))
      .map((item) => Object.assign({}, item, {
        remainingAmount: getRemainingAmount(item)
      }))
    : [];

  if (customer) {
    nextFields.customerId = customer.id;
    if (explicitlyUnlinked) nextFields.unlinkedPaymentCustomerId = customer.id;
  }

  const selected = receivables.find((item) => item.id === nextFields.receivableId) || null;
  const paymentAmount = toMoney(nextFields.paymentAmount);
  const matchedReceivableOptions = receivables.map((item) => ({
    id: item.id,
    label: formatReceivableOption(item)
  }));
  const receivableOptions = receivables.length
    ? [{ id: UNLINKED_RECEIVABLE_OPTION_ID, label: '不关联本次收款（仅记一笔收款）' }].concat(matchedReceivableOptions)
    : matchedReceivableOptions;
  const receivableRange = receivableOptions.map((item) => item.label);
  const selectedIndex = explicitlyUnlinked
    ? receivableOptions.findIndex((item) => item.id === UNLINKED_RECEIVABLE_OPTION_ID)
    : receivableOptions.findIndex((item) => selected && item.id === selected.id);
  const paymentPreview = [];
  const newReceivablePreview = [];
  let paymentWarningText = '';
  let newReceivableWarningText = '';
  let operation = 'record_payment';
  const remainingAmount = toMoney(nextFields.remainingAmount);
  const shouldCreateReceivableWithPayment = suggestedOperation === 'create_receivable_with_payment'
    && !receivables.length
    && paymentAmount > 0
    && remainingAmount > 0;

  if (shouldCreateReceivableWithPayment) {
    operation = 'create_receivable_with_payment';
    nextFields.amount = String(toMoney(paymentAmount + remainingAmount));
    delete nextFields.receivableId;
    newReceivablePreview.push(`将新建待收总额：${formatMoney(nextFields.amount)}元`);
    newReceivablePreview.push(`本次已收：${formatMoney(paymentAmount)}元`);
    newReceivablePreview.push(`还差：${formatMoney(remainingAmount)}元`);
    newReceivableWarningText = '这笔没有匹配到旧待收；确认后会新建待收并记录本次收款。';
  } else if (explicitlyUnlinked) {
    delete nextFields.receivableId;
    paymentPreview.push('将仅记录一笔未关联收款，不会核销任何待收款 / 欠款。');
    if (paymentAmount > 0) paymentPreview.push(`本次收款：${formatMoney(paymentAmount)}元`);
    paymentWarningText = '已明确选择不关联；后续如需核对，请在记录详情中查看原始内容。';
  } else if (!receivables.length) {
    delete nextFields.unlinkedPaymentCustomerId;
    delete nextFields.receivableId;
    paymentPreview.push('没有匹配到旧待收款 / 欠款，将保存为未关联收款，不会自动核销或新建欠款。');
    if (paymentAmount > 0) paymentPreview.push(`本次收款：${formatMoney(paymentAmount)}元`);
  } else if (!selected || !receivableSelectionConfirmed) {
    delete nextFields.unlinkedPaymentCustomerId;
    low.push('receivableId');
    paymentWarningText = selected
      ? '已匹配到待收款 / 欠款；请在下方点选确认，或选择不关联本次收款。'
      : (receivables.length === 1
        ? '已找到一笔可关联待收款 / 欠款；请确认是否核销，或选择不关联本次收款。'
        : '这个客户有多笔未结清待收款 / 欠款；选择后会核销对应记录，不选择则保存为未关联收款。');
  } else {
    delete nextFields.unlinkedPaymentCustomerId;
    const selectedLow = low.filter((field) => field !== 'receivableId');
    low.length = 0;
    low.push(...selectedLow);
    const paidBefore = toMoney(selected.paidAmount);
    const remainingBefore = getRemainingAmount(selected);
    const paidAfter = toMoney(paidBefore + paymentAmount);
    const remainingAfter = Math.max(0, toMoney(toMoney(selected.amount) - paidAfter));
    const statusAfter = remainingAfter <= 0 ? '已结清' : '部分收款';
    paymentPreview.push(`匹配待收款：待收${formatMoney(selected.amount)}元，到期${selected.dueDate || '-'}`);
    paymentPreview.push(`收款前：已收${formatMoney(paidBefore)}元，剩余${formatMoney(remainingBefore)}元`);
    paymentPreview.push(`本次收款：${formatMoney(paymentAmount)}元`);
    paymentPreview.push(`收款后：已收${formatMoney(paidAfter)}元，剩余${formatMoney(remainingAfter)}元`);
    paymentPreview.push(`保存后状态：${statusAfter}`);

    if (paymentAmount > remainingBefore) {
      low.push('paymentAmount');
      paymentWarningText = '本次收款金额大于当前剩余金额，请确认是否录错。';
    }

    if (nextFields.remainingAmount) {
      const expectedRemaining = toMoney(nextFields.remainingAmount);
      if (Math.abs(expectedRemaining - remainingAfter) > 0.01) {
        low.push('remainingAmount');
        paymentWarningText = `原话说还剩${formatMoney(expectedRemaining)}元，但系统计算保存后剩${formatMoney(remainingAfter)}元。`;
      }
    }
  }

  const missing = uniqueFields(normalizePaymentMissing(aiMissingFields, nextFields, operation)
    .concat(getMissing('payment', nextFields, operation)));

  return {
    fields: nextFields,
    operation,
    missingFields: missing,
    lowConfidenceFields: uniqueFields(low),
    paymentPreview,
    paymentWarningText,
    newReceivablePreview,
    newReceivableWarningText,
    receivableOptions,
    receivableRange,
    selectedReceivableIndex: selectedIndex,
    selectedReceivableLabel: selectedIndex >= 0 ? receivableRange[selectedIndex] : ''
  };
}

function getClientRouteName(parseResult = {}) {
  const route = parseResult.parse_route || {};
  return String(route.semantic_decision || route.semanticDecision || route.decision || '').toUpperCase();
}

function getAssistantQuestionType(question = {}) {
  const type = String(question.questionType || question.answerType || '').trim().toUpperCase();
  return ASSISTANT_QUESTION_TYPES.has(type) ? type : 'UNKNOWN';
}

function getAssistantQuestionId(input = {}) {
  return stableHash({
    confirmationSessionId: input.confirmationSessionId,
    draftRevision: input.draftRevision,
    fieldPath: input.fieldPath,
    questionBusinessDate: input.questionBusinessDate,
    questionType: input.questionType,
    riskIds: uniqueFields(input.riskIds || []).sort()
  }, 'record-confirm-assistant-question');
}

function normalizeAssistantQuestionAnswer(question = {}, rawAnswer = '') {
  const answer = String(rawAnswer || '').trim();
  if (!answer) return { accepted: false, code: 'ANSWER_EMPTY' };
  const type = getAssistantQuestionType(question);
  if (type === 'UNKNOWN') return { accepted: false, code: 'ANSWER_TYPE_UNSUPPORTED' };
  const target = question.target || {};
  const field = String(target.field || '').trim();
  const fieldPath = String(target.fieldPath || '').trim();
  const itemKey = String(target.itemKey || '').trim();

  if (type === 'TEXT') return { accepted: true, value: answer };
  if (type === 'DATE') {
    if (field !== 'dueDate' || fieldPath !== 'dueDate' || itemKey) {
      return { accepted: false, code: 'ANSWER_TYPE_TARGET_MISMATCH' };
    }
    const businessDate = String(question.businessDate || '').trim();
    const businessDateDetail = parseChineseDateDetail(businessDate, businessDate);
    if (!businessDate
      || businessDateDetail.ambiguous
      || businessDateDetail.invalid
      || businessDateDetail.date !== businessDate
      || String(businessDateDetail.matchedText || '').trim() !== businessDate) {
      return { accepted: false, code: 'ANSWER_DATE_CONTEXT_INVALID' };
    }
    const detail = parseChineseDateDetail(answer, businessDate);
    if (!detail.date
      || detail.ambiguous
      || detail.invalid
      || String(detail.matchedText || '').trim() !== answer) {
      return { accepted: false, code: 'ANSWER_DATE_INVALID' };
    }
    return { accepted: true, value: detail.date };
  }

  const validNumberTarget = (field === 'amount' && fieldPath === 'amount' && !itemKey)
    || (['quantity', 'unitPrice'].includes(field)
      && Boolean(itemKey)
      && new RegExp(`^items\\[\\d+\\]\\.${field}$`).test(fieldPath));
  if (!validNumberTarget) {
    return { accepted: false, code: 'ANSWER_TYPE_TARGET_MISMATCH' };
  }
  const normalizedText = normalizeNumberText(answer);
  if (!new RegExp(`^(?:${numberPattern()})$`).test(normalizedText)) {
    return { accepted: false, code: 'ANSWER_NUMBER_INVALID' };
  }
  const value = parseChineseNumber(normalizedText);
  if (!Number.isFinite(value) || value <= 0) {
    return { accepted: false, code: 'ANSWER_NUMBER_INVALID' };
  }
  return { accepted: true, value: String(value) };
}

function buildActiveAssistantQuestion(parseResult, confirmItems) {
  if (getClientRouteName(parseResult) !== ROUTE_ASK_USER) return null;
  const route = parseResult.parse_route || {};
  const candidate = route.questionCandidate || route.activeQuestion || {};
  const candidateTarget = candidate.target || {};
  const field = String(candidateTarget.field || candidate.field || '').trim();
  const itemIndex = Number.isInteger(candidateTarget.itemIndex)
    ? candidateTarget.itemIndex
    : (field === 'productName' ? 0 : -1);
  const item = itemIndex >= 0 ? confirmItems[itemIndex] : null;
  const itemKey = item ? String(item.confirmationItemKey || item.itemKey || '') : '';
  const fieldPath = String(candidateTarget.fieldPath || candidate.fieldPath
    || (itemIndex >= 0 ? `items[${itemIndex}].${field}` : field));
  const context = parseResult.client_confirmation_context || {};
  const risks = collectUserResolvableAiRisks(parseResult, parseResult.fields || {})
    .filter((risk) => (
      itemIndex >= 0
        ? risk.itemKey === itemKey && risk.itemField === field
        : risk.field === field
    ));
  const trustedRiskIds = risks.map((risk) => risk.riskId);
  const riskIds = uniqueFields(trustedRiskIds.length ? trustedRiskIds : (candidate.riskIds || []));
  const questionType = getAssistantQuestionType(candidate);
  const questionBusinessDate = String(context.businessDate || '').trim();
  if (!field
    || (itemIndex >= 0 && !itemKey)
    || !String(context.originalTextFingerprint || '').trim()
    || !String(context.draftRevision || '').trim()
    || !String(context.confirmationSessionId || '').trim()
    || !questionBusinessDate) return null;
  const questionId = getAssistantQuestionId({
    confirmationSessionId: context.confirmationSessionId,
    draftRevision: context.draftRevision,
    fieldPath,
    questionBusinessDate,
    questionType,
    riskIds
  });
  return {
    answerType: questionType.toLowerCase(),
    businessDate: questionBusinessDate,
    confirmationSessionId: context.confirmationSessionId,
    draftRevision: context.draftRevision,
    field,
    fieldPath,
    itemKey,
    originalTextFingerprint: context.originalTextFingerprint,
    prompt: String(candidate.prompt || '').trim(),
    questionId,
    questionType,
    riskIds: riskIds.length ? riskIds : [`REQUIRED|${fieldPath}`],
    status: 'OPEN',
    target: { field, fieldPath, itemIndex, itemKey }
  };
}

function recalculateOrderAmountFields(fields = {}, explicitAmount) {
  const next = Object.assign({}, fields);
  const items = normalizeConfirmItems(next, { ensureFirst: true }).map((item) => {
    const updated = Object.assign({}, item);
    if (hasMoneyValue(updated.quantity)
      && hasMoneyValue(updated.unitPrice)
      && unitsMatch(updated.unit, updated.priceUnit || updated.unit)) {
      updated.totalAmount = formatMoneyValue(Number(updated.quantity) * Number(updated.unitPrice));
    }
    return updated;
  });
  const calculatedAmount = calculateConfirmItemsTotalAmount(items);
  next.items = items;
  if (calculatedAmount !== '') next.calculatedAmount = calculatedAmount;
  if (explicitAmount !== undefined) {
    const statedAmount = String(explicitAmount).trim();
    next.statedAmount = statedAmount;
    next.amount = statedAmount;
    next.totalAmount = statedAmount;
  }
  return syncFirstItemToLegacyFields(next, { preserveConfirmedAmount: true });
}

function riskIdReferencesField(riskId, field) {
  return String(riskId || '').split('|').includes(String(field || ''));
}

function projectTrustedResolvedFields(reviewed) {
  const resolution = reviewed.user_resolution || {};
  const resolvedRiskIds = new Set(resolution.resolvedRiskIds || []);
  const unresolvedRiskIds = resolution.unresolvedRiskIds || [];
  const proofs = Array.isArray(reviewed.user_manual_edits) ? reviewed.user_manual_edits : [];
  const resolvedFields = uniqueFields(proofs
    .filter((proof) => (proof.riskIds || []).some((riskId) => resolvedRiskIds.has(riskId)))
    .map((proof) => proof.field)
    .filter((field) => !unresolvedRiskIds.some((riskId) => riskIdReferencesField(riskId, field))));
  if (!resolvedFields.length) return reviewed;
  const finalSafety = reviewed.final_parse_safety || {};
  const validations = finalSafety.field_validations || {};
  const hardInvalidFields = validations.invalid_fields || [];
  const hardConflictFields = validations.conflict_fields || [];
  const safelyResolvedFields = resolvedFields.filter((field) => (
    !hardInvalidFields.includes(field) && !hardConflictFields.includes(field)
  ));
  if (!safelyResolvedFields.length) return reviewed;
  const withoutResolved = (values) => uniqueFields(values || [])
    .filter((field) => !safelyResolvedFields.includes(field));
  return Object.assign({}, reviewed, {
    missing_fields: withoutResolved(reviewed.missing_fields),
    low_confidence_fields: withoutResolved(reviewed.low_confidence_fields),
    final_parse_safety: Object.assign({}, finalSafety, {
      unsafe_fields: withoutResolved(finalSafety.unsafe_fields),
      missing_fields: withoutResolved(finalSafety.missing_fields),
      low_confidence_fields: withoutResolved(finalSafety.low_confidence_fields),
      evidence_missing_fields: withoutResolved(finalSafety.evidence_missing_fields),
      field_validations: Object.assign({}, validations, {
        issues: (validations.issues || []).filter((issue) => (
          !safelyResolvedFields.includes(issue && issue.field)
        )),
        semantic_low_fields: withoutResolved(validations.semantic_low_fields)
      })
    })
  });
}

function rerouteClientDraft(parseResult, fields) {
  let reviewed = applyFinalParseSafety(Object.assign({}, parseResult, { fields }));
  // 第一轮 final safety 过滤旧 conflict；第二轮用已过滤的风险数组
  // 重算稳态 status。助理回答 proof 的指纹不依赖 parse_route，因此不会
  // 因这次稳态重算丢失人工回答证据。
  reviewed = applyFinalParseSafety(reviewed);
  reviewed = projectTrustedResolvedFields(reviewed);
  let finalSafety = reviewed.final_parse_safety || reviewed.local_parse_safety || {};
  const finalValidations = finalSafety.field_validations || {};
  const factRisksResolved = !(reviewed.missing_fields || []).length
    && !(reviewed.low_confidence_fields || []).length
    && !(reviewed.field_conflicts || []).length
    && !(finalValidations.invalid_fields || []).length
    && !(finalValidations.conflict_fields || []).length;
  if (factRisksResolved) {
    finalSafety = Object.assign({}, finalSafety, {
      evidence_missing_fields: [],
      evidence_reason_texts: [],
      evidence_sufficient: true,
      field_validations: {
        conflict_fields: [],
        invalid_fields: [],
        issues: [],
        semantic_low_fields: []
      },
      low_confidence_fields: [],
      missing_fields: [],
      reason_texts: [],
      safe_to_auto_accept: true,
      status: 'SAFE_LOCAL',
      unsafe_fields: []
    });
  }
  const routeInput = Object.assign({}, reviewed, { local_parse_safety: finalSafety });
  const route = getParseRouteDecision({
    inputChannel: reviewed.source === 'voice' ? 'VOICE_TRANSCRIPT' : 'MANUAL_TEXT',
    rawText: reviewed.original_text || '',
    source: reviewed.source || 'typed',
    text: reviewed.original_text || ''
  }, routeInput, reviewed.context_policy || 'none');
  reviewed = Object.assign({}, reviewed, {
    local_parse_safety: finalSafety,
    parse_route: route
  });
  return reviewed;
}

function buildConfirmationState(state, parseResult, intent, fields) {
  let operation = ['update_order', 'update_quotation'].includes(parseResult.operation)
    ? parseResult.operation
    : (operationByIntent[intent] || 'pending');
  let nextFields = Object.assign({}, fields);
  let missingFields = [];
  let lowConfidenceFields = uniqueFields(parseResult.low_confidence_fields || []);
  let paymentState = {
    paymentPreview: [],
    paymentWarningText: '',
    newReceivablePreview: [],
    newReceivableWarningText: '',
    receivableOptions: [],
    receivableRange: [],
    selectedReceivableIndex: -1
  };
  let orderDepositState = {
    orderDepositPreview: [],
    orderDepositWarningText: '',
    orderOptions: [],
    orderRange: [],
    selectedOrderIndex: -1
  };
  let customerMatchState = emptyCustomerMatchState(nextFields);

  if (intent === 'dunning') {
    nextFields.todoType = 'dunning';
    if (!nextFields.todoTitle && nextFields.customerName) nextFields.todoTitle = `催${nextFields.customerName}款`;
  }

  if (intent === 'quotation' && nextFields.quotationId) {
    const hydrated = hydrateQuotationFields(state, nextFields);
    if (hydrated) {
      operation = 'update_quotation';
      nextFields = hydrated;
    } else {
      lowConfidenceFields.push('quotationId');
    }
  }

  nextFields = ensureQuotationFollowupFields(nextFields, operation);

  if (intent === 'order' && nextFields.orderId) {
    const hydrated = hydrateOrderFields(state, nextFields);
    if (hydrated) {
      operation = 'update_order';
      nextFields = hydrated;
    } else {
      lowConfidenceFields.push('orderId');
    }
  }

  if (['quotation', 'order'].includes(intent)) {
    nextFields = syncFirstItemToLegacyFields(nextFields, {
      preserveConfirmedAmount: Array.isArray(parseResult.manual_fields)
        && parseResult.manual_fields.includes('amount')
    });
  }

  if (intent === 'order' && operation === 'create_order') {
    const totalAmount = toMoney(nextFields.totalAmount || nextFields.amount);
    const depositAmount = toMoney(nextFields.depositAmount || nextFields.paymentAmount);
    if (depositAmount > 0 && (totalAmount <= 0 || depositAmount > totalAmount)) {
      lowConfidenceFields.push('depositAmount');
    }
  }

  const isOrderDeposit = parseResult.operation === 'record_order_deposit'
    || nextFields.paymentKind === 'deposit'
    || nextFields.depositAmount;

  if (intent === 'payment' && isOrderDeposit) {
    orderDepositState = buildOrderDepositState(state, nextFields, parseResult.missing_fields || [], lowConfidenceFields);
    operation = orderDepositState.operation;
    nextFields = orderDepositState.fields;
    missingFields = orderDepositState.missingFields;
    lowConfidenceFields = orderDepositState.lowConfidenceFields;
  } else if (intent === 'payment') {
    paymentState = buildPaymentState(
      state,
      nextFields,
      parseResult.missing_fields || [],
      lowConfidenceFields,
      parseResult.suggested_operation
    );
    operation = paymentState.operation;
    nextFields = paymentState.fields;
    missingFields = paymentState.missingFields;
    lowConfidenceFields = paymentState.lowConfidenceFields;
  } else {
    missingFields = mergeMissing(intent, nextFields, parseResult.missing_fields || [], operation);
  }

  if (intent === 'payment' && operation === 'record_payment') {
    const paymentDate = String(nextFields.paymentDate || nextFields.dueDate || '').trim();
    if (paymentDate) {
      nextFields.dueDate = paymentDate;
    }
  }

  customerMatchState = buildCustomerMatchState(state, nextFields, operation);
  nextFields = customerMatchState.fields;

  missingFields = getVisibleFields(filterRelevantWarningFields(uniqueFields(missingFields), intent, operation), nextFields);
  lowConfidenceFields = filterRelevantWarningFields(uniqueFields(lowConfidenceFields), intent, operation);
  // UI 可见字段会过滤不属于当前卡片的 warning，但 final safety 必须
  // 继续看到上一轮未解决的完整风险集。否则多问题场景会在第一个
  // 回答后改变 riskSetFingerprint，导致已签名的用户回答被错误丢弃。
  const safetyMissingFields = uniqueFields([].concat(
    parseResult.missing_fields || [],
    missingFields
  ));
  const safetyLowConfidenceFields = uniqueFields([].concat(
    parseResult.low_confidence_fields || [],
    lowConfidenceFields
  ));

  let visibility = getFieldVisibility(intent, operation, nextFields);
  let normalizedParseResult = Object.assign({}, parseResult, {
    intent,
    fields: nextFields,
    operation,
    missing_fields: safetyMissingFields,
    low_confidence_fields: safetyLowConfidenceFields
  });
  normalizedParseResult = applyFinalParseSafety(normalizedParseResult);
  nextFields = normalizedParseResult.fields || nextFields;
  customerMatchState = buildCustomerMatchState(state, nextFields, operation);
  nextFields = customerMatchState.fields;
  normalizedParseResult = Object.assign({}, normalizedParseResult, {
    fields: nextFields
  });
  visibility = getFieldVisibility(intent, operation, nextFields);
  missingFields = normalizedParseResult.missing_fields || [];
  lowConfidenceFields = normalizedParseResult.low_confidence_fields || [];
  const warningState = getWarningState(missingFields, lowConfidenceFields, nextFields);
  const fieldConflictLines = formatFieldConflicts(normalizedParseResult.field_conflicts || []);
  const supersededFactLines = formatSupersededFacts(normalizedParseResult.superseded_facts || []);
  const remarkItemLines = formatRemarkItems(normalizedParseResult.remark_items || []);
  const confirmItems = ['quotation', 'order'].includes(intent) ? buildConfirmItemCards(nextFields, intent, state) : [];
  const orderAmountSummaryLines = intent === 'order' ? buildOrderAmountSummary(nextFields) : [];
  const localParseSafetyLines = formatLocalParseSafety(normalizedParseResult.local_parse_safety);
  const safetyBlockText = getFormalSaveSafetyBlockText(normalizedParseResult);
  const productSuggestion = (normalizedParseResult.field_suggestions || {}).productName || {};
  const finalWarningState = safetyBlockText
    ? Object.assign({}, warningState, {
      showWarning: true,
      warningLowText: warningState.warningLowText || safetyBlockText
    })
    : warningState;
  const flowContext = getTrustedRecordFlowContext(normalizedParseResult);
  const domainPreflight = evaluateRecordDomainPreflight({
    mode: flowContext.mode || 'PRODUCTION_ROUTING',
    resultScope: flowContext.resultScope || 'PRODUCTION_RESULT',
    operation,
    businessType: intent,
    finalResult: normalizedParseResult,
    originalText: normalizedParseResult.original_text || '',
    initialState: state,
    aiOutcome: flowContext.aiOutcome || (normalizedParseResult.ai_fallback || {}).status || 'not_requested',
    providerKind: flowContext.providerKind || (normalizedParseResult.ai_fallback || {}).provider_kind || 'NONE',
    skipFinalSafety: true
  });
  const genericOrderSelectionState = buildGenericOrderSelectionState(
    state,
    nextFields,
    operation,
    domainPreflight
  );
  const genericQuotationSelectionState = buildGenericQuotationSelectionState(
    nextFields,
    operation,
    domainPreflight
  );
  const orderSelectionState = operation === 'record_order_deposit'
    ? Object.assign({}, orderDepositState, {
      orderCandidates: [],
      selectedOrderId: nextFields.orderId || '',
      selectedOrder: null,
      orderSelectionRequired: false,
      orderSelectionReason: '',
      orderSelectionBaseFields: null,
      showGenericOrderSelection: false,
      showGenericOrderPicker: false
    })
    : Object.assign({}, orderDepositState, genericOrderSelectionState);
  const clientRouteName = getClientRouteName(normalizedParseResult);
  const activeQuestion = clientRouteName === ROUTE_ASK_USER
    ? buildActiveAssistantQuestion(normalizedParseResult, confirmItems)
    : null;
  // An ASK_USER decision without a trusted, renderable question is not a
  // confirmation. Fail closed into the recovery surface instead.
  const safeBlocked = clientRouteName === ROUTE_SAFE_BLOCKED
    || (clientRouteName === ROUTE_ASK_USER && !activeQuestion);
  const clientRouteBlocked = Boolean(activeQuestion) || safeBlocked;
  const canFormalSave = domainPreflight.domainCanSaveFormal === true;
  const noRecordPersistenceForbidden = domainPreflight.noRecordPersistenceForbidden === true;
  const canPendingSave = domainPreflight.domainCanSavePending === true
    && !noRecordPersistenceForbidden;
  const domainBlockingLines = formatDomainBlockingIssues(domainPreflight.blockingIssues);
  const userResolution = evaluateUserResolvedAiState(normalizedParseResult);
  const isReturnedUncertain = ((normalizedParseResult.ai_fallback || {}).status) === 'returned_uncertain';
  const historyDefaultedFields = uniqueFields(normalizedParseResult.history_defaulted_fields || []);
  const surfaceProjection = buildConfirmationSurfaceProjection({
    activeQuestion,
    confirmItems,
    domainPreflight,
    fields: nextFields,
    intent,
    parseResult: normalizedParseResult,
    safeBlocked
  });
  const surfaceConfirmItems = confirmItems.map((item) => Object.assign({}, item, {
    riskByField: surfaceProjection.riskByItem[item.itemKey] || {}
  }));

  const confirmationData = Object.assign({
    parseResult: normalizedParseResult,
    parseEvidence: buildParseEvidence(normalizedParseResult),
    showParseEvidence: false,
    fields: nextFields,
    confirmItems: surfaceConfirmItems,
    operation,
    operationTitle: operationTitles[operation],
    amountLabel: operation === 'create_receivable_with_payment' ? '待收总额' : (intent === 'receivable' ? '待收金额' : '金额/总价'),
    paymentAmountLabel: operation === 'record_order_deposit'
      ? '本次定金'
      : (intent === 'order' && (nextFields.depositAmount || nextFields.paymentKind === 'deposit') ? '定金金额' : '本次收款'),
    dueDateLabel: operation === 'record_payment'
      ? '收款日期'
      : (['todo', 'dunning'].includes(intent) ? '提醒日期' : (intent === 'receivable' ? '到期日' : (intent === 'quotation' ? '跟进日期' : '交期'))),
    selectedFollowupDayIndex: getFollowupDayIndex(nextFields.followupDays),
    followupWarningText: nextFields.dueDate
      ? `已设置跟进日期：${nextFields.dueDate}。`
      : '跟进日期可选；未填写时不会自动补日期。',
    guessedSummary: getGuessedSummary(nextFields),
    historyWarningText: normalizedParseResult.history_warning_text || '',
    showHistoryWarning: Boolean(normalizedParseResult.history_warning_text),
    historyDefaultWarningText: normalizedParseResult.history_default_warning_text || '',
    showHistoryDefaultWarning: Boolean(normalizedParseResult.history_default_warning_text),
    domainCanSaveFormal: domainPreflight.domainCanSaveFormal,
    domainCanSavePending: domainPreflight.domainCanSavePending,
    effectiveCanSaveFormal: canFormalSave && !noRecordPersistenceForbidden,
    effectiveCanSavePending: canPendingSave,
    surfaceCanCompleteFormal: !noRecordPersistenceForbidden,
    isNoRecord: noRecordPersistenceForbidden,
    noRecordMessage: noRecordPersistenceForbidden ? '没有识别到需要记录的生意事项' : '',
    domainPreflight,
    userResolution,
    preflightFingerprint: domainPreflight.preflightFingerprint,
    preflightBlockingReasons: domainPreflight.blockingIssues.map((item) => item.code),
    domainBlockingLines,
    showDomainBlocking: Boolean(domainBlockingLines.length),
    activeQuestion,
    assistantAnswerValue: '',
    assistantQuestionState: activeQuestion ? 'ASKING' : (safeBlocked ? 'SAFE_BLOCKED' : 'READY'),
    assistantQuestions: activeQuestion ? [activeQuestion] : [],
    parseAssistText: userResolution.status === 'MANUAL_RESOLUTION_COMPLETE'
      ? '你已逐项补齐不确定内容，请再次确认后保存。'
      : (isReturnedUncertain
        ? '智能核对仍有未确认内容，请按下方阻断原因逐项修改。'
        : ''),
    fieldConflictLines,
    showFieldConflicts: Boolean(fieldConflictLines.length),
    orderAmountSummaryLines,
    orderAmountSupplementaryLines: orderAmountSummaryLines.slice(1),
    showOrderAmountSummary: Boolean(orderAmountSummaryLines.length),
    localParseSafetyLines,
    showLocalParseSafety: Boolean(localParseSafetyLines.length),
    productSuggestionText: productSuggestion.text || '',
    productSuggestionValue: productSuggestion.value || '',
    showProductSuggestion: Boolean(productSuggestion.text && productSuggestion.value),
    supersededFactLines,
    showSupersededFacts: Boolean(supersededFactLines.length),
    remarkItemLines,
    showRemarkItems: Boolean(remarkItemLines.length),
    historyDefaultFieldMap: getFieldFlagMap(historyDefaultedFields),
    formalButtonText: operation === 'update_order' ? '确认更新订单' : '确认保存',
    disableFormalSave: !canFormalSave || noRecordPersistenceForbidden || clientRouteBlocked,
    showFormalSaveButton: !noRecordPersistenceForbidden,
    showPendingButton: canPendingSave,
    showPaymentConfirm: operation === 'record_payment',
    showNewReceivableWithPayment: operation === 'create_receivable_with_payment',
    showReceivablePicker: operation === 'record_payment' && paymentState.receivableOptions.length > 1,
    showOrderDepositConfirm: operation === 'record_order_deposit',
    showOrderPicker: operation === 'record_order_deposit' && orderDepositState.orderOptions.length > 1,
    showDeepReviewButton: false
  }, visibility, finalWarningState, paymentState, orderSelectionState,
  genericQuotationSelectionState, customerMatchState, surfaceProjection);
  if (safeBlocked && !confirmationData.safeBlockedMessage) {
    confirmationData.safeBlockedMessage = '这笔信息暂时无法确认，请重新输入原话';
  }
  return Object.assign(confirmationData, {
    conversationPhase: deriveConversationPhase(confirmationData)
  });
}

function getSourceState(source) {
  const config = sourceButtonConfig[source] || sourceButtonConfig.typed;
  return {
    typedClass: config.typedClass,
    pasteClass: config.pasteClass,
    voiceClass: config.voiceClass,
    showPaste: config.showPaste,
    showVoice: config.showVoice
  };
}

function getEmptyConfirmationData() {
  return {
    conversationPhase: CONVERSATION_PHASE_INPUT,
    text: '',
    parseResult: null,
    parseEvidence: null,
    activeQuestion: null,
    assistantAnswerValue: '',
    assistantQuestionState: 'IDLE',
    assistantQuestions: [],
    saving: false,
    showParseProgress: false,
    parseProgressTitle: '',
    parseProgressDetail: '',
    showParseEvidence: false,
    showDeepReviewButton: false,
    showFormalSaveButton: false,
    showPendingButton: false,
    isNoRecord: false,
    noRecordMessage: '',
    effectiveCanSaveFormal: false,
    effectiveCanSavePending: false,
    lastNoRecordActionRejection: null,
    fields: {},
    confirmItems: [],
    riskByField: {},
    riskByItem: {},
    amountSurface: {
      canonicalTotalText: '',
      canonicalTotalValue: '',
      errorText: '',
      hasError: false,
      message: '',
      riskText: '',
      statedValue: ''
    },
    originalTextExpanded: false,
    safeBlockedMessage: '',
    showSurfaceGlobalRisk: false,
    surfaceConfirmTitle: surfaceConfirmTitles.unknown,
    surfaceGlobalRiskText: '',
    surfaceOriginalText: '',
    intent: 'unknown',
    operation: 'pending',
    operationTitle: operationTitles.pending,
    amountLabel: '金额/总价',
    paymentAmountLabel: '本次收款',
    dueDateLabel: '日期',
    intentLabel: INTENT_LABELS.unknown,
    showComputedTips: false,
    showHistoryWarning: false,
    showHistoryDefaultWarning: false,
    showFieldConflicts: false,
    showOrderAmountSummary: false,
    showLocalParseSafety: false,
    showDomainBlocking: false,
    showSupersededFacts: false,
    showRemarkItems: false,
    showWarning: false,
    showCustomerFields: false,
    showPhoneField: false,
    showTodoTitleField: false,
    showFollowupDaysField: false,
    showItemList: false,
    showProductField: false,
    showQuantityFields: false,
    showPriceFields: false,
    showAmountField: false,
    showPaymentAmountField: false,
    showRemainingAmountField: false,
    showDueDateField: false,
    showRemarkField: false,
    showGenericDraft: false,
    showPaymentConfirm: false,
    showNewReceivableWithPayment: false,
    showReceivablePicker: false,
    showOrderDepositConfirm: false,
    showOrderPicker: false,
    warningMissingText: '',
    warningLowText: '',
    fieldConflictLines: [],
    orderAmountSummaryLines: [],
    orderAmountSupplementaryLines: [],
    localParseSafetyLines: [],
    domainBlockingLines: [],
    supersededFactLines: [],
    remarkItemLines: [],
    historyWarningText: '',
    historyDefaultWarningText: '',
    historyDefaultFieldMap: {},
    followupWarningText: '',
    followupDayRange: FOLLOWUP_DAY_RANGE,
    selectedFollowupDayIndex: DEFAULT_QUOTATION_FOLLOWUP_DAYS - 1,
    formalButtonText: '确认保存',
    disableFormalSave: false,
    guessedSummary: [],
    paymentPreview: [],
    paymentWarningText: '',
    newReceivablePreview: [],
    newReceivableWarningText: '',
    receivableOptions: [],
    receivableRange: [],
    selectedReceivableIndex: -1,
    selectedReceivableLabel: '',
    orderDepositPreview: [],
    orderDepositWarningText: '',
    orderOptions: [],
    orderRange: [],
    selectedOrderIndex: -1,
    selectedOrderLabel: '',
    selectedOrderId: '',
    selectedOrder: null,
    orderCandidates: [],
    orderSelectionRequired: false,
    orderSelectionReason: '',
    orderSelectionBaseFields: null,
    showGenericOrderSelection: false,
    showGenericOrderPicker: false,
    quotationOptions: [],
    quotationRange: [],
    selectedQuotationIndex: -1,
    selectedQuotationLabel: '',
    selectedQuotationId: '',
    selectedQuotation: null,
    quotationCandidates: [],
    quotationSelectionRequired: false,
    quotationSelectionReason: '',
    quotationSelectionConfirmed: false,
    quotationSelectionBaseFields: null,
    quotationSelectionRootFields: null,
    showGenericQuotationSelection: false,
    showGenericQuotationPicker: false,
    showCustomerMatchBox: false,
    showCustomerPicker: false,
    showCustomerDisambiguationField: false,
    customerMatchText: '',
    customerMatchWarningText: '',
    customerHistoryTitle: '',
    customerHistoryLines: [],
    showCustomerHistoryConfirm: false,
    customerMatchRange: [],
    customerMatchOptions: [],
    selectedCustomerIndex: -1,
    selectedCustomerLabel: '',
    customerMatchBlocksSave: false,
    pasteAnalysis: null,
    editingPendingId: '',
    computedTips: []
  };
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
    showParseProgress: true,
    parseProgressTitle: copy[0][0],
    parseProgressDetail: copy[0][1]
  });
  page.parseProgressRevealTimer = setTimeout(show, 180);
  [2600, 7600, 15000].forEach((delay, index) => {
    page.parseProgressTimers.push(setTimeout(() => {
      if (!page.data.parsing) return;
      page.setData({
        parseProgressTitle: copy[index + 1][0],
        parseProgressDetail: copy[index + 1][1]
      });
    }, delay));
  });
}

function finishParseProgress(page) {
  clearParseProgress(page);
  page.setData({ showParseProgress: false });
}

function nextClientRuntimeId(page, prefix) {
  page.clientRuntimeSequence = Number(page.clientRuntimeSequence || 0) + 1;
  return `${prefix}-${Date.now()}-${page.clientRuntimeSequence}`;
}

function invalidateRawInputCapture(page, reasonCode = 'RAW_INPUT_CAPTURE_INVALIDATED') {
  const active = rawInputCaptureRegistry.get(page) || null;
  rawInputCaptureRegistry.delete(page);
  page.rawInputCaptureRevision = Number(page.rawInputCaptureRevision || 0) + 1;
  if (active && active.source === 'voice') {
    page.voiceCancelled = true;
    cancelVoiceRecognition(reasonCode);
    if (page.data) {
      page.setData({
        voiceRecording: false,
        voiceButtonClass: 'voice-button-idle',
        voiceButtonText: '按住说一句',
        voiceTip: '已切换输入方式。'
      });
    }
  }
  return active;
}

function beginRawInputCapture(page, source, options = {}) {
  invalidateRawInputCapture(page, `NEW_${String(source || 'INPUT').toUpperCase()}_CAPTURE`);
  page.rawInputCaptureSequence = Number(page.rawInputCaptureSequence || 0) + 1;
  const capture = Object.freeze({
    append: Boolean(options.append),
    captureId: `raw-input-capture-${Date.now()}-${page.rawInputCaptureSequence}`,
    captureRevision: Number(page.rawInputCaptureRevision || 0),
    source: String(source || ''),
    startOriginalText: getCurrentOriginalText(page),
    startRawText: String(page.data && page.data.text || '')
  });
  rawInputCaptureRegistry.set(page, capture);
  return capture;
}

function isRawInputCaptureCurrent(page, capture, options = {}) {
  if (!capture || rawInputCaptureRegistry.get(page) !== capture) return false;
  if (Number(page.rawInputCaptureRevision || 0) !== Number(capture.captureRevision)) return false;
  if (options.verifyStartText === true
    && String(page.data && page.data.text || '') !== capture.startRawText) return false;
  return true;
}

function completeRawInputCapture(page, capture) {
  if (!isRawInputCaptureCurrent(page, capture)) return false;
  rawInputCaptureRegistry.delete(page);
  return true;
}

function ensureConfirmationSession(page) {
  if (!page.confirmationSessionId) {
    page.confirmationSessionId = nextClientRuntimeId(page, 'confirm-session');
  }
  return page.confirmationSessionId;
}

function ensureConfirmationBusinessDate(page) {
  if (!page.confirmationBusinessDate) page.confirmationBusinessDate = today();
  return page.confirmationBusinessDate;
}

function getOriginalTextFingerprint(text) {
  return stableHash({ text: String(text || '') }, 'record-confirm-original-text');
}

function invalidateActiveParseIdentity(page) {
  page.activeParseRequestToken = null;
  page.activeParseIdentity = null;
}

function advanceDraftRevision(page, options = {}) {
  page.draftRevision = Number(page.draftRevision || 0) + 1;
  if (options.newSession === true) {
    page.confirmationSessionId = nextClientRuntimeId(page, 'confirm-session');
    page.confirmationBusinessDate = today();
    page.hasTrustedCandidateFactChange = false;
  } else {
    ensureConfirmationSession(page);
  }
  invalidateActiveParseIdentity(page);
  if (page.data && page.data.parsing) {
    finishParseProgress(page);
    page.setData({
      parsing: false,
      parseButtonText: '生成确认卡'
    });
  }
  return page.draftRevision;
}

function attachClientConfirmationContext(result, identity) {
  return Object.assign({}, result, {
    client_confirmation_context: {
      businessDate: identity.businessDate,
      confirmationSessionId: identity.confirmationSessionId,
      draftRevision: identity.draftRevision,
      originalTextFingerprint: identity.originalTextFingerprint,
      requestedRoute: identity.requestedRoute,
      requestId: identity.requestId
    }
  });
}

function getCurrentOriginalText(page) {
  if (!page || !page.data) return '';
  return String(
    page.data.source === 'paste' && page.pasteOriginalText
      ? page.pasteOriginalText
      : page.data.text || ''
  );
}

function getCurrentConfirmationIdentity(page) {
  return {
    businessDate: ensureConfirmationBusinessDate(page),
    confirmationSessionId: ensureConfirmationSession(page),
    draftRevision: String(page.draftRevision || ''),
    originalTextFingerprint: getOriginalTextFingerprint(getCurrentOriginalText(page)),
    requestedRoute: page.currentRequestedRoute || 'ROUTE_UNDECIDED'
  };
}

function isParseIdentityCurrent(page, identity) {
  const current = getCurrentConfirmationIdentity(page);
  return Boolean(page.activeParseIdentity)
    && page.activeParseIdentity.requestId === identity.requestId
    && current.businessDate === identity.businessDate
    && current.confirmationSessionId === identity.confirmationSessionId
    && current.draftRevision === String(identity.draftRevision)
    && current.originalTextFingerprint === identity.originalTextFingerprint
    && current.requestedRoute === identity.requestedRoute;
}

function attachCurrentDraftContext(page, result) {
  const current = getCurrentConfirmationIdentity(page);
  return attachClientConfirmationContext(result, Object.assign({}, current, {
    requestId: ''
  }));
}

function rebuildAfterClientDraftEdit(page, parseResult, fields) {
  advanceDraftRevision(page);
  return attachCurrentDraftContext(page, rerouteClientDraft(parseResult, fields));
}

function rebuildAfterCandidateFactChange(page, parseResult) {
  advanceDraftRevision(page);
  // This marker lives only on the Page instance. It cannot be supplied by an
  // AI/HTTP payload and tells a later parse action to preserve relationship or
  // picker facts the user selected on the current confirmation card.
  page.hasTrustedCandidateFactChange = true;
  return attachCurrentDraftContext(page, parseResult);
}

function hasCurrentUserDraftEdits(parseResult = {}) {
  return (Array.isArray(parseResult.manual_fields) && parseResult.manual_fields.length > 0)
    || (Array.isArray(parseResult.manual_item_fields) && parseResult.manual_item_fields.length > 0)
    || (Array.isArray(parseResult.user_manual_edits) && parseResult.user_manual_edits.length > 0);
}

function hasAssistantAnswerProof(parseResult = {}) {
  return Array.isArray(parseResult.user_manual_edits)
    && parseResult.user_manual_edits.some((proof) => (
      proof && proof.source === 'USER_ASSISTANT_ANSWER'
    ));
}

function trackParseOperation(page, identity, operation) {
  const tracked = { identity, promise: operation, settled: false };
  page.inFlightParseOperation = tracked;
  operation.then(() => {
    tracked.settled = true;
    if (page.inFlightParseOperation === tracked) page.inFlightParseOperation = null;
  }, () => {
    tracked.settled = true;
    if (page.inFlightParseOperation === tracked) page.inFlightParseOperation = null;
  });
  return operation;
}

function canRunConfirmationSave(page) {
  const inFlight = page.inFlightParseOperation;
  return deriveConversationPhase(page.data || {}) === CONVERSATION_PHASE_CONFIRMING
    && page.data.parsing !== true
    && page.data.showParseProgress !== true
    && !page.activeParseIdentity
    && !(inFlight && inFlight.settled !== true)
    && page.savingInProgress !== true;
}

function canRunPendingSave(page) {
  const inFlight = page.inFlightParseOperation;
  const phase = deriveConversationPhase(page.data || {});
  return phase !== CONVERSATION_PHASE_INPUT
    && phase !== CONVERSATION_PHASE_AUTO_REVIEW
    && phase !== CONVERSATION_PHASE_SAVING
    && page.data.parsing !== true
    && page.data.showParseProgress !== true
    && !page.activeParseIdentity
    && !(inFlight && inFlight.settled !== true)
    && page.savingInProgress !== true;
}

function formalSaveExitPatch() {
  return {
    saving: false,
    showParseProgress: false,
    parseProgressTitle: '',
    parseProgressDetail: ''
  };
}

function commitFormalSaveExitSnapshot(page, patch) {
  const projection = withConversationPhase(page.data || {}, patch);
  if (page.data && typeof page.data === 'object') {
    Object.assign(page.data, projection);
  }
  return projection;
}

function finalizeFormalSavePresentation(page, committed) {
  page.savingInProgress = false;
  const patch = committed
    ? Object.assign(getEmptyConfirmationData(), formalSaveExitPatch())
    : formalSaveExitPatch();
  try {
    if (committed) page.setData(patch);
    else setConversationData(page, patch);
    return true;
  } catch (error) {
    // setData 包装层若只抛一次，重试同一纯展示投影即可恢复；这里绝不重放业务保存。
    try {
      if (committed) page.setData(patch);
      else setConversationData(page, patch);
      return true;
    } catch (ignored) {
      // 连续的展示层异常也不能把保存权威状态留在 SAVING。先同步释放 Page
      // 状态，再做一次纯展示投影；这里始终不会重放 business/storage 保存。
      const fallbackProjection = commitFormalSaveExitSnapshot(page, patch);
      try {
        page.setData(fallbackProjection);
        return true;
      } catch (finalProjectionError) {
        return false;
      }
    }
  }
}

function showFormalSaveToast(payload) {
  try {
    wx.showToast(payload);
    return true;
  } catch (ignored) {
    return false;
  }
}

function buildTrustedAmountReviewText(originalText, question, canonicalAmount) {
  const target = question && question.target || {};
  if (getAssistantQuestionType(question) !== 'NUMBER'
    || String(target.field || '') !== 'amount'
    || String(target.fieldPath || '') !== 'amount'
    || String(target.itemKey || '')) return '';
  const text = String(originalText || '');
  const amount = String(canonicalAmount || '').trim();
  if (!text.trim() || !amount || !/^\d+(?:\.\d+)?$/.test(amount)) return '';
  const pattern = /((?:总金额|总价|总计|合计|金额)\s*(?:是|为|按)?\s*)([零〇一二两三四五六七八九十百千万亿点\d.]+)(\s*(?:元|块钱|块))/g;
  const matches = Array.from(text.matchAll(pattern));
  if (matches.length !== 1) return '';
  const match = matches[0];
  const start = Number(match.index || 0);
  const prefix = match[1];
  const suffix = match[3];
  return `${text.slice(0, start)}${prefix}${amount}${suffix}${text.slice(start + match[0].length)}`;
}

function buildSafeBlockedAnswerState(confirmationState, code) {
  const blockedState = Object.assign({}, confirmationState, {
    activeQuestion: null,
    assistantReviewFailureCode: code || 'ASSISTANT_REVIEW_UNAVAILABLE',
    assistantQuestionState: 'SAFE_BLOCKED',
    assistantQuestions: [],
    disableFormalSave: true,
    safeBlockedMessage: '这笔信息暂时无法确认，请重新输入原话'
  });
  return Object.assign(blockedState, {
    conversationPhase: deriveConversationPhase(blockedState)
  });
}

Page({
  data: {
    conversationPhase: CONVERSATION_PHASE_INPUT,
    source: 'typed',
    sourceLabels: INPUT_SOURCE_LABELS,
    text: '',
    parseResult: null,
    parseEvidence: null,
    activeQuestion: null,
    assistantAnswerValue: '',
    assistantQuestionState: 'IDLE',
    assistantQuestions: [],
    showParseEvidence: false,
    fields: {},
    confirmItems: [],
    riskByField: {},
    riskByItem: {},
    amountSurface: {
      canonicalTotalText: '',
      canonicalTotalValue: '',
      errorText: '',
      hasError: false,
      message: '',
      riskText: '',
      statedValue: ''
    },
    originalTextExpanded: false,
    safeBlockedMessage: '',
    showSurfaceGlobalRisk: false,
    surfaceConfirmTitle: surfaceConfirmTitles.unknown,
    surfaceGlobalRiskText: '',
    surfaceOriginalText: '',
    intent: 'unknown',
    operation: 'pending',
    operationTitle: operationTitles.pending,
    amountLabel: '金额/总价',
    paymentAmountLabel: '本次收款',
    dueDateLabel: '日期',
    intentOptions,
    intentRange,
    intentLabel: INTENT_LABELS.unknown,
    intentLabels: INTENT_LABELS,
    sourceLabel: INPUT_SOURCE_LABELS.typed,
    voiceRecording: false,
    voiceTip: '按住说出客户、产品和金额；松开后我会先转成文字给你确认。',
    voiceButtonClass: 'voice-button-idle',
    voiceButtonText: '按住说一句',
    parsing: false,
    saving: false,
    parseButtonText: '生成确认卡',
    parseAssistText: '',
    showParseProgress: false,
    parseProgressTitle: '',
    parseProgressDetail: '',
    pasteAnalysis: null,
    editingPendingId: '',
    intentCandidatesText: '',
    typedClass: 'segment active',
    pasteClass: 'segment',
    voiceClass: 'segment',
    showPaste: false,
    showVoice: false,
    showComputedTips: false,
    showHistoryWarning: false,
    showHistoryDefaultWarning: false,
    showOrderAmountSummary: false,
    showWarning: false,
    showCustomerFields: false,
    showPhoneField: false,
    showTodoTitleField: false,
    showFollowupDaysField: false,
    showItemList: false,
    showProductField: false,
    showQuantityFields: false,
    showPriceFields: false,
    showAmountField: false,
    showPaymentAmountField: false,
    showRemainingAmountField: false,
    showDueDateField: false,
    showRemarkField: false,
    showGenericDraft: false,
    showPaymentConfirm: false,
    showNewReceivableWithPayment: false,
    showReceivablePicker: false,
    warningMissingText: '',
    warningLowText: '',
    orderAmountSummaryLines: [],
    orderAmountSupplementaryLines: [],
    historyWarningText: '',
    historyDefaultWarningText: '',
    historyDefaultFieldMap: {},
    followupWarningText: '',
    followupDayRange: FOLLOWUP_DAY_RANGE,
    selectedFollowupDayIndex: DEFAULT_QUOTATION_FOLLOWUP_DAYS - 1,
    formalButtonText: '确认保存',
    disableFormalSave: false,
    guessedSummary: [],
    paymentPreview: [],
    paymentWarningText: '',
    newReceivablePreview: [],
    newReceivableWarningText: '',
    receivableOptions: [],
    receivableRange: [],
    selectedReceivableIndex: -1,
    selectedReceivableLabel: '',
    orderDepositPreview: [],
    orderDepositWarningText: '',
    orderOptions: [],
    orderRange: [],
    selectedOrderIndex: -1,
    selectedOrderLabel: '',
    selectedOrderId: '',
    selectedOrder: null,
    orderCandidates: [],
    orderSelectionRequired: false,
    orderSelectionReason: '',
    orderSelectionBaseFields: null,
    showGenericOrderSelection: false,
    showGenericOrderPicker: false,
    quotationOptions: [],
    quotationRange: [],
    selectedQuotationIndex: -1,
    selectedQuotationLabel: '',
    selectedQuotationId: '',
    selectedQuotation: null,
    quotationCandidates: [],
    quotationSelectionRequired: false,
    quotationSelectionReason: '',
    quotationSelectionConfirmed: false,
    quotationSelectionBaseFields: null,
    quotationSelectionRootFields: null,
    showGenericQuotationSelection: false,
    showGenericQuotationPicker: false,
    showCustomerMatchBox: false,
    showCustomerPicker: false,
    showCustomerDisambiguationField: false,
    customerMatchText: '',
    customerMatchWarningText: '',
    customerHistoryTitle: '',
    customerHistoryLines: [],
    showCustomerHistoryConfirm: false,
    customerMatchRange: [],
    customerMatchOptions: [],
    selectedCustomerIndex: -1,
    selectedCustomerLabel: '',
    customerMatchBlocksSave: false,
    computedTips: []
  },

  onLoad(options) {
    if (options.pendingId) {
      this.loadPendingForEdit(options.pendingId);
    }
  },

  onShow() {
    refreshTabBarSelected(this);
    requestOrderFilterReset();
    // 页面一出现就准备登录；普通快速核对不会在 8 秒内临时等待登录。
    prewarmAiAuth();
    const pendingId = wx.getStorageSync('pending_to_edit');
    if (pendingId) {
      if (hasPendingRecordEntryHandoff()) consumeRecordEntryHandoff();
      wx.removeStorageSync('pending_to_edit');
      this.loadPendingForEdit(pendingId);
      return;
    }
    const recordToEdit = wx.getStorageSync('record_to_edit');
    if (recordToEdit && recordToEdit.type === 'order' && recordToEdit.id) {
      if (hasPendingRecordEntryHandoff()) consumeRecordEntryHandoff();
      wx.removeStorageSync('record_to_edit');
      this.loadOrderForEdit(recordToEdit.id);
      return;
    }
    if (hasPendingRecordEntryHandoff()) {
      const handoff = consumeRecordEntryHandoff();
      const originalText = String(handoff && handoff.originalText || '');
      const source = String(handoff && handoff.source || '');
      const inputChannel = String(handoff && handoff.inputChannel || '');
      const originSurface = String(handoff && handoff.originSurface || '');
      const expectedInputChannel = source === 'voice'
        ? 'VOICE_TRANSCRIPT'
        : (source === 'paste' ? 'PASTE_TEXT' : 'MANUAL_TEXT');
      const handoffVoiceCompletionEvidence = source === 'voice'
        ? handoff && handoff.voiceCompletionEvidence || null
        : null;
      const allowedOriginSurface = source === 'voice'
        ? ['DASHBOARD_HERO', 'CUSTOM_TAB_CENTER', 'HOME_QUICK'].includes(originSurface)
        : originSurface === 'HOME_QUICK';
      if (handoff
        && handoff.autoParse === true
        && allowedOriginSurface
        && originalText.trim()
        && ['typed', 'paste', 'voice'].includes(source)
        && inputChannel === expectedInputChannel) {
        wx.removeStorageSync('force_text_input');
        wx.removeStorageSync('draft_to_input');
        invalidateRawInputCapture(this, 'DASHBOARD_ENTRY_HANDOFF');
        invalidateActiveParseIdentity(this);
        if (this.voiceCompletionEvidence) {
          invalidateVoiceCompletionEvidence(this.voiceCompletionEvidence, 'DASHBOARD_ENTRY_HANDOFF');
          this.voiceCompletionEvidence = null;
        }
        if (source === 'voice') {
          const validation = validateVoiceCompletionEvidence(
            handoffVoiceCompletionEvidence,
            originalText,
            { inputChannel }
          );
          this.voiceCompletionEvidence = validation.valid
            ? validation.evidence
            : null;
        }
        clearParseProgress(this);
        advanceDraftRevision(this, { newSession: true });
        this.currentRequestedRoute = 'ROUTE_UNDECIDED';
        this.pasteOriginalText = source === 'paste' ? originalText : '';
        setConversationData(this, Object.assign({}, getEmptyConfirmationData(), {
          text: originalText,
          source,
          sourceLabel: INPUT_SOURCE_LABELS[source],
          fields: {},
          confirmItems: [],
          pasteAnalysis: source === 'paste' ? analyzeClipboardText(originalText) : null,
          parseButtonText: '生成确认卡',
          parseAssistText: '',
          showFormalSaveButton: false,
          showPendingButton: false,
          showParseProgress: false
        }, getSourceState(source)), () => {
          this.runParse('standard', {
            entrySurface: source === 'voice' ? 'HOME_QUICK' : 'FULL_PAGE',
            inputChannel,
            originSurface,
            voiceCompletionEvidence: source === 'voice'
              ? handoffVoiceCompletionEvidence
              : null
          });
        });
        return;
      }
    }
    const forceTextInput = wx.getStorageSync('force_text_input');
    if (forceTextInput) {
      invalidateRawInputCapture(this, 'FORCE_TEXT_INPUT');
      this.pasteOriginalText = '';
      wx.removeStorageSync('force_text_input');
      this.setData(Object.assign(getEmptyConfirmationData(), {
        source: 'typed',
        sourceLabel: INPUT_SOURCE_LABELS.typed,
        parseButtonText: '生成确认卡',
        parseAssistText: ''
      }, getSourceState('typed')));
      return;
    }
    const draft = wx.getStorageSync('draft_to_input');
    if (draft && draft.text) {
      invalidateRawInputCapture(this, 'DRAFT_TO_INPUT');
      wx.removeStorageSync('draft_to_input');
      const source = draft.source || 'typed';
      this.pasteOriginalText = source === 'paste' ? String(draft.text || '') : '';
      this.setData(Object.assign(getEmptyConfirmationData(), {
        text: draft.text,
        source,
        sourceLabel: INPUT_SOURCE_LABELS[source] || INPUT_SOURCE_LABELS.typed,
        parseButtonText: '生成确认卡',
        parseAssistText: ''
      }, getSourceState(source)));
    }
  },

  onHide() {
    invalidateRawInputCapture(this, 'FULL_PAGE_HIDDEN');
    invalidateActiveParseIdentity(this);
    this.confirmationSessionId = '';
    this.confirmationBusinessDate = '';
    if (this.voiceCompletionEvidence) {
      invalidateVoiceCompletionEvidence(this.voiceCompletionEvidence, 'FULL_PAGE_HIDDEN');
      this.voiceCompletionEvidence = null;
    }
    this.cancelVoice();
    finishParseProgress(this);
    setConversationData(this, {
      parsing: false,
      showParseProgress: false,
      parseButtonText: '生成确认卡'
    });
  },

  onUnload() {
    invalidateRawInputCapture(this, 'FULL_PAGE_UNLOAD');
    invalidateActiveParseIdentity(this);
    this.confirmationSessionId = '';
    this.confirmationBusinessDate = '';
    clearParseProgress(this);
    if (this.voiceCompletionEvidence) {
      invalidateVoiceCompletionEvidence(this.voiceCompletionEvidence, 'FULL_PAGE_UNLOAD');
      this.voiceCompletionEvidence = null;
    }
    if (this.data.voiceRecording) {
      this.voiceCancelled = true;
      cancelVoiceRecognition('FULL_PAGE_UNLOAD');
    }
  },

  loadPendingForEdit(pendingId) {
    const state = getState();
    const note = state.pendingNotes.find((item) => item.id === pendingId);
    if (note) {
      invalidateRawInputCapture(this, 'PENDING_DRAFT_LOADED');
      const source = note.source || 'typed';
      this.pasteOriginalText = source === 'paste' ? String(note.originalText || '') : '';
      this.setData(Object.assign(getEmptyConfirmationData(), {
        text: note.originalText,
        source,
        sourceLabel: INPUT_SOURCE_LABELS[source],
        editingPendingId: pendingId
      }, getSourceState(source)));
    }
  },

  setSource(event) {
    const source = event.currentTarget.dataset.source;
    invalidateRawInputCapture(this, 'INPUT_SOURCE_CHANGED');
    advanceDraftRevision(this, { newSession: true });
    if (this.voiceCompletionEvidence) {
      invalidateVoiceCompletionEvidence(this.voiceCompletionEvidence, 'INPUT_SOURCE_CHANGED');
      this.voiceCompletionEvidence = null;
    }
    this.pasteOriginalText = source === 'paste' ? String(this.data.text || '') : '';
    setConversationData(this, Object.assign({}, getEmptyConfirmationData(), {
      text: this.data.text,
      source,
      sourceLabel: INPUT_SOURCE_LABELS[source],
    }, getSourceState(source)));
  },

  onTextInput(event) {
    const text = event.detail.value;
    const textChanged = String(text || '') !== String(this.data.text || '');
    invalidateRawInputCapture(this, 'MANUAL_RAW_INPUT');
    if (textChanged) advanceDraftRevision(this, { newSession: true });
    if (this.voiceCompletionEvidence) {
      invalidateVoiceCompletionEvidence(this.voiceCompletionEvidence, 'MANUAL_EDIT_AFTER_VOICE');
      this.voiceCompletionEvidence = null;
    }
    if (textChanged && this.data.parsing) clearParseProgress(this);
    if (String(text || '').trim()) prewarmAiAuth();
    if (isWechatChatText(text)) {
      const analysis = analyzeClipboardText(text);
      this.pasteOriginalText = String(text || '');
      const diagnosticText = getClipboardDiagnostics(analysis);
      setConversationData(this, Object.assign({
        source: 'paste',
        sourceLabel: INPUT_SOURCE_LABELS.paste,
        text,
        pasteAnalysis: analysis,
        parseAssistText: [diagnosticText, analysis.warning].filter(Boolean).join('\n')
      }, textChanged ? {
        activeQuestion: null,
        assistantQuestionState: 'IDLE',
        assistantQuestions: [],
        confirmItems: [],
        fields: {},
        parseResult: null,
        parsing: false,
        parseButtonText: '生成确认卡',
        showParseProgress: false,
        showFormalSaveButton: false,
        showPendingButton: false
      } : {}, getSourceState('paste')));
      return;
    }
    this.pasteOriginalText = '';
    setConversationData(this, Object.assign({
      text,
      source: 'typed',
      sourceLabel: INPUT_SOURCE_LABELS.typed,
      pasteAnalysis: null
    }, textChanged ? {
      activeQuestion: null,
      assistantQuestionState: 'IDLE',
      assistantQuestions: [],
      confirmItems: [],
      fields: {},
      parseResult: null,
      parsing: false,
      parseButtonText: '生成确认卡',
      showParseProgress: false,
      showFormalSaveButton: false,
      showPendingButton: false
    } : {}));
  },

  readClipboardToInput(options = {}) {
    const append = Boolean(options.append);
    const capture = beginRawInputCapture(this, 'clipboard', { append });
    advanceDraftRevision(this, { newSession: true });
    if (this.voiceCompletionEvidence) {
      invalidateVoiceCompletionEvidence(this.voiceCompletionEvidence, 'PASTE_REPLACED_VOICE_INPUT');
      this.voiceCompletionEvidence = null;
    }
    wx.getClipboardData({
      success: (res) => {
        if (!isRawInputCaptureCurrent(this, capture, { verifyStartText: true })) return;
        const clipboardText = String(res.data || '');
        const analysis = analyzeClipboardText(clipboardText);
        if (!analysis.rawText) {
          completeRawInputCapture(this, capture);
          wx.showToast({ title: '剪贴板是空的', icon: 'none' });
          return;
        }
        const displayText = getClipboardDisplayText(analysis);
        const currentText = append ? capture.startRawText.trim() : '';
        const currentOriginalText = append ? capture.startOriginalText : '';
        const nextText = currentText && displayText
          ? `${currentText}\n\n${displayText}`
          : displayText;
        this.pasteOriginalText = append && currentOriginalText.trim()
          ? `${currentOriginalText}\n\n${clipboardText}`
          : clipboardText;
        const nextAnalysis = append ? analyzeClipboardText(nextText) : analysis;
        const singleMessage = isSingleMessageClipboard(analysis);
        const diagnosticText = getClipboardDiagnostics(nextAnalysis);
        const assistText = singleMessage
          ? `${diagnosticText}\n${getSingleMessagePasteTip()}`
          : [diagnosticText, nextAnalysis.warning].filter(Boolean).join('\n');
        this.setData(Object.assign({
          source: 'paste',
          sourceLabel: INPUT_SOURCE_LABELS.paste,
          text: nextText,
          pasteAnalysis: nextAnalysis,
          parseAssistText: assistText
        }, getSourceState('paste')), () => {
          if (!completeRawInputCapture(this, capture)) return;
          if (nextAnalysis.status === 'ok') {
            this.runParse();
            return;
          }
          if (singleMessage) {
            wx.showToast({ title: '只读到1条消息', icon: 'none' });
            return;
          }
          this.showNoBusinessPaste(nextAnalysis);
        });
      }
    });
  },

  pasteClipboard() {
    this.readClipboardToInput({ append: false });
  },

  appendClipboard() {
    this.readClipboardToInput({ append: true });
  },

  showNoBusinessPaste(analysis) {
    const parseResult = buildNoBusinessPasteResult(analysis);
    const state = getState();
    const confirmationState = buildConfirmationState(state, parseResult, parseResult.intent, parseResult.fields);
    this.setData(Object.assign({}, confirmationState, {
      source: 'paste',
      sourceLabel: INPUT_SOURCE_LABELS.paste,
      intent: confirmationState.parseResult.intent,
      intentLabel: INTENT_LABELS[confirmationState.parseResult.intent],
      parseAssistText: analysis.warning || '没有识别到可保存的业务内容。',
      intentCandidatesText: '',
      parsing: false,
      parseButtonText: '生成确认卡',
      pasteAnalysis: analysis
    }, getSourceState('paste')));
  },

  startVoice() {
    if (this.data.voiceRecording) return;
    // 录音期间预先完成登录；失败不打断录音，真正解析时会给出明确原因。
    prewarmAiAuth();
    const capture = beginRawInputCapture(this, 'voice');
    this.pasteOriginalText = '';
    this.voiceCancelled = false;
    advanceDraftRevision(this, { newSession: true });
    if (this.voiceCompletionEvidence) {
      invalidateVoiceCompletionEvidence(this.voiceCompletionEvidence, 'NEW_VOICE_SESSION_STARTED');
      this.voiceCompletionEvidence = null;
    }
    this.setData(Object.assign({
      source: 'voice',
      sourceLabel: INPUT_SOURCE_LABELS.voice,
      voiceRecording: true,
      voiceButtonClass: 'voice-button-recording',
      voiceButtonText: '松开结束',
      voiceTip: '正在听，请说清客户、产品、数量或金额。',
      parseAssistText: ''
    }, getSourceState('voice')));

    startVoiceRecognition({
      duration: 60000,
      lang: 'zh_CN',
      onRecognize: (result) => {
        if (!isRawInputCaptureCurrent(this, capture)) return;
        const partialText = String((result && result.text) || '').trim();
        if (!this.data.voiceRecording || !partialText) return;
        this.setData({ voiceTip: `正在听：${partialText}` });
      },
      onStop: () => {
        if (!isRawInputCaptureCurrent(this, capture)) return;
        if (this.voiceCancelled) return;
        this.setData({
          voiceRecording: false,
          voiceButtonClass: 'voice-button-idle',
          voiceButtonText: '正在整理…',
          voiceTip: '已收到，正在转成文字。'
        });
      },
      onResult: (result) => {
        if (!isRawInputCaptureCurrent(this, capture, { verifyStartText: true })) return;
        const text = String((result && result.text) || '').trim();
        if (this.voiceCancelled) {
          this.setData({
            voiceRecording: false,
            voiceButtonClass: 'voice-button-idle',
            voiceButtonText: '按住说一句',
            voiceTip: '已取消，可以再按住说一次。'
          });
          return;
        }
        const voiceCompletionEvidence = result && result.voiceCompletionEvidence || null;
        const validation = validateVoiceCompletionEvidence(
          voiceCompletionEvidence,
          text,
          { inputChannel: 'VOICE_TRANSCRIPT' }
        );
        this.voiceCompletionEvidence = validation.valid
          ? voiceCompletionEvidence
          : null;
        this.setData(Object.assign({
          text,
          source: 'voice',
          sourceLabel: INPUT_SOURCE_LABELS.voice,
          voiceRecording: false,
          voiceButtonClass: 'voice-button-idle',
          voiceButtonText: '按住说一句',
          voiceTip: '已转成文字，正在整理成确认卡。',
          pasteAnalysis: null
        }, getSourceState('voice')), () => {
          if (!completeRawInputCapture(this, capture)) return;
          this.runParse('standard', {
            entrySurface: 'FULL_PAGE',
            inputChannel: 'VOICE_TRANSCRIPT',
            voiceCompletionEvidence: this.voiceCompletionEvidence
          });
        });
      },
      onError: (error) => {
        if (!completeRawInputCapture(this, capture)) return;
        this.voiceCompletionEvidence = null;
        this.setData({
          voiceRecording: false,
          voiceButtonClass: 'voice-button-idle',
          voiceButtonText: '按住说一句',
          voiceTip: (error && error.message) || '没有听清楚，请再说一次。'
        });
      }
    });
  },

  loadOrderForEdit(orderId) {
    invalidateRawInputCapture(this, 'ORDER_DRAFT_LOADED');
    this.pasteOriginalText = '';
    const state = getState();
    const parseResult = buildOrderEditDraft(state, orderId);
    if (!parseResult) {
      wx.showToast({ title: '没有找到这笔订单', icon: 'none' });
      return;
    }
    const confirmationState = buildConfirmationState(state, parseResult, 'order', parseResult.fields);
    this.setData(Object.assign({}, getEmptyConfirmationData(), confirmationState, {
      text: parseResult.original_text || '',
      source: 'typed',
      sourceLabel: INPUT_SOURCE_LABELS.typed,
      intent: 'order',
      intentLabel: INTENT_LABELS.order,
      formalButtonText: confirmationState.disableFormalSave ? '补齐后更新' : '确认更新订单',
      parseAssistText: '正在修改这笔订单。保存后会记录修改日志，原始内容仍会保留。'
    }, getSourceState('typed')));
  },

  stopVoice() {
    if (!this.data.voiceRecording) return;
    stopVoiceRecognition();
  },

  cancelVoice() {
    if (!this.data.voiceRecording) return;
    invalidateRawInputCapture(this, 'FULL_PAGE_VOICE_CANCELLED');
    this.voiceCancelled = true;
    if (this.voiceCompletionEvidence) {
      invalidateVoiceCompletionEvidence(this.voiceCompletionEvidence, 'FULL_PAGE_VOICE_CANCELLED');
      this.voiceCompletionEvidence = null;
    }
    cancelVoiceRecognition('FULL_PAGE_VOICE_CANCELLED');
    this.setData({
      voiceRecording: false,
      voiceButtonClass: 'voice-button-idle',
      voiceButtonText: '按住说一句',
      voiceTip: '已取消，可以再按住说一次。'
    });
  },

  runParse(reviewMode = 'standard', sourceContext = null) {
    let text = this.data.text.trim();
    let pasteAnalysis = null;
    let source = this.data.source;
    const sourceOriginalText = source === 'paste'
      ? String(this.pasteOriginalText || this.data.text || '')
      : String(this.data.text || '');
    if (text && (this.data.source === 'paste' || isWechatChatText(text))) {
      if (this.data.source === 'paste' && !isWechatChatText(this.data.text)) {
        text = sourceOriginalText.trim();
        source = 'paste';
      } else {
        pasteAnalysis = this.data.pasteAnalysis && (
          this.data.pasteAnalysis.rawText === this.data.text
          || this.data.pasteAnalysis.extractedText === this.data.text
        )
          ? this.data.pasteAnalysis
          : analyzeClipboardText(this.data.text);
        if (pasteAnalysis.status !== 'ok') {
          this.showNoBusinessPaste(pasteAnalysis);
          return;
        } else {
          text = pasteAnalysis.extractedText;
          source = 'paste';
        }
      }
    }
    if (!this.data.text.trim()) {
      wx.showToast({ title: '先输入一句话或粘贴聊天', icon: 'none' });
      return;
    }
    const currentFingerprint = getOriginalTextFingerprint(sourceOriginalText);
    const currentBusinessDate = ensureConfirmationBusinessDate(this);
    const currentSessionId = ensureConfirmationSession(this);
    const existing = this.inFlightParseOperation;
    if (existing
      && existing.settled !== true
      && existing.identity.businessDate === currentBusinessDate
      && existing.identity.originalTextFingerprint === currentFingerprint
      && String(existing.identity.draftRevision) === String(this.draftRevision || '')
      && existing.identity.confirmationSessionId === currentSessionId
      && existing.identity.requestedRoute === (this.currentRequestedRoute || 'ROUTE_UNDECIDED')) {
      return existing.promise;
    }

    const currentDraft = this.data.parseResult;
    const currentDraftContext = currentDraft && currentDraft.client_confirmation_context || {};
    const sameOriginalDraft = Boolean(currentDraft)
      && (String(currentDraftContext.originalTextFingerprint || '') === currentFingerprint
        || (!currentDraftContext.originalTextFingerprint
          && String(currentDraft.original_text || '') === String(text || '')));
    if (sameOriginalDraft && (
      hasCurrentUserDraftEdits(currentDraft)
      || this.hasTrustedCandidateFactChange === true
    )) {
      // A new parse action must never rebuild from the original sentence over
      // facts the user has already corrected on this card. Assistant-answer
      // proofs are bound to the active question context, so a no-op recheck of
      // that same draft keeps the context instead of invalidating the answer.
      if (!hasAssistantAnswerProof(currentDraft)) advanceDraftRevision(this);
      let preservedResult = rerouteClientDraft(currentDraft, this.data.fields || currentDraft.fields || {});
      const preservedRoute = getClientRouteName(preservedResult);
      this.currentRequestedRoute = preservedRoute || 'ROUTE_UNDECIDED';
      preservedResult = attachCurrentDraftContext(this, preservedResult);
      const preservedState = buildConfirmationState(
        getState(),
        preservedResult,
        preservedResult.intent,
        preservedResult.fields
      );
      this.setData(Object.assign({}, preservedState, {
        intent: preservedState.parseResult.intent,
        intentLabel: INTENT_LABELS[preservedState.parseResult.intent],
        parsing: false,
        parseButtonText: '生成确认卡',
        parseAssistText: getClientRouteName(preservedState.parseResult) === ROUTE_SAFE_BLOCKED
          ? '当前内容还不能安全保存，请按提示继续确认。'
          : '已保留你刚修改的内容，请确认后保存。'
      }));
      return Promise.resolve(preservedState.parseResult);
    }

    advanceDraftRevision(this);
    this.currentRequestedRoute = 'ROUTE_UNDECIDED';
    const identity = {
      businessDate: currentBusinessDate,
      confirmationSessionId: ensureConfirmationSession(this),
      draftRevision: String(this.draftRevision),
      originalTextFingerprint: currentFingerprint,
      requestedRoute: this.currentRequestedRoute,
      requestId: nextClientRuntimeId(this, 'record-parse-request')
    };
    const parseRequestToken = identity.requestId;
    this.activeParseRequestToken = parseRequestToken;
    this.activeParseIdentity = identity;
    setConversationData(this, {
      parsing: true,
      showParseProgress: true,
      parseProgressTitle: source === 'paste' ? '正在整理聊天内容' : '正在整理这条记录',
      parseProgressDetail: '请稍等，确认前不会自动保存',
      parseButtonText: '正在识别',
      parseAssistText: '正在识别，请稍等。'
    });
    startParseProgress(this, source);
    const state = getState();
    const payload = {
      text,
      source,
      context: 'home',
      state,
      reviewMode: 'standard',
      requestId: identity.requestId,
      originalTextFingerprint: identity.originalTextFingerprint,
      draftRevision: identity.draftRevision,
      confirmationSessionId: identity.confirmationSessionId,
      requestedRoute: identity.requestedRoute,
      onTrustedClientRouteDecision: (decision = {}) => {
        if (!this.activeParseIdentity
          || this.activeParseIdentity.requestId !== identity.requestId) return;
        const requestedRoute = String(decision.requestedRoute || '').trim();
        if (!requestedRoute) return;
        identity.requestedRoute = requestedRoute;
        this.currentRequestedRoute = requestedRoute;
      }
    };
    if (source === 'voice') {
      const requestedEvidence = sourceContext && sourceContext.voiceCompletionEvidence
        || this.voiceCompletionEvidence
        || null;
      const validation = validateVoiceCompletionEvidence(
        requestedEvidence,
        text,
        { inputChannel: 'VOICE_TRANSCRIPT' }
      );
      payload.inputChannel = 'VOICE_TRANSCRIPT';
      payload.entrySurface = sourceContext && sourceContext.entrySurface || 'FULL_PAGE';
      payload.originSurface = sourceContext && sourceContext.originSurface
        || payload.entrySurface;
      if (requestedEvidence) {
        payload.voiceCompletionEvidence = validation.valid
          ? validation.evidence
          : requestedEvidence;
      }
    } else {
      payload.inputChannel = source === 'paste' ? 'PASTE_TEXT' : 'MANUAL_TEXT';
      payload.entrySurface = 'FULL_PAGE';
    }
    if (pasteAnalysis) {
      payload.rawText = sourceOriginalText;
      payload.extractedText = pasteAnalysis.extractedText;
      payload.pasteMeta = getPasteMeta(pasteAnalysis);
    }
    const operation = parseHybridInput(payload)
      .then((parseResult) => {
        if (!isParseIdentityCurrent(this, identity)) return;
        invalidateActiveParseIdentity(this);
        clearParseProgress(this);
        if (sourceOriginalText) {
          parseResult = Object.assign({}, parseResult, {
            original_text: sourceOriginalText
          }, source === 'paste' ? {
            raw_text: sourceOriginalText
          } : {});
        }
        const contextualResult = attachClientConfirmationContext(parseResult, identity);
        const confirmationState = buildConfirmationState(
          state,
          contextualResult,
          contextualResult.intent,
          contextualResult.fields
        );
        const routeName = getClientRouteName(confirmationState.parseResult);
        const aiStatusText = routeName === ROUTE_ASK_USER
          ? ''
          : (routeName === ROUTE_SAFE_BLOCKED
            ? '暂时没能自动核对完整，当前不能保存。'
            : '已整理好，请确认后保存。');
        setConversationData(this, Object.assign({}, confirmationState, {
          intent: confirmationState.parseResult.intent,
          intentLabel: INTENT_LABELS[confirmationState.parseResult.intent],
          sourceLabel: INPUT_SOURCE_LABELS[confirmationState.parseResult.source],
          parseAssistText: aiStatusText,
          intentCandidatesText: (confirmationState.parseResult.intent_candidates || [])
            .map((item) => INTENT_LABELS[item] || item)
            .join(' / '),
          parsing: false,
          showParseProgress: false,
          parseButtonText: '生成确认卡',
          showComputedTips: Boolean(confirmationState.parseResult.computed_tips && confirmationState.parseResult.computed_tips.length),
          computedTips: confirmationState.parseResult.computed_tips || []
        }));
      })
      .catch(() => {
        if (!isParseIdentityCurrent(this, identity)) return;
        invalidateActiveParseIdentity(this);
        clearParseProgress(this);
        setConversationData(this, {
          activeQuestion: null,
          assistantQuestionState: 'SAFE_BLOCKED',
          assistantQuestions: [],
          assistantAnswerValue: '',
          disableFormalSave: true,
          parsing: false,
          showParseProgress: false,
          parseButtonText: '生成确认卡',
          parseAssistText: '暂时没能整理完整，请稍后再试。',
          safeBlockedMessage: '这笔信息暂时无法确认，请重新输入原话'
        });
      });
    return trackParseOperation(this, identity, operation);
  },

  startTrustedAssistantAnswerDeepReview(confirmationState, question) {
    const committedResult = confirmationState && confirmationState.parseResult || {};
    const committedFields = confirmationState && confirmationState.fields
      || committedResult.fields
      || {};
    const currentOriginalText = getCurrentOriginalText(this);
    const canonicalText = buildTrustedAmountReviewText(
      currentOriginalText,
      question,
      committedFields.amount
    );
    const originalTextFingerprint = getOriginalTextFingerprint(currentOriginalText);
    const context = committedResult.client_confirmation_context || {};
    const identityValid = canonicalText
      && String(question.confirmationSessionId || '') === String(this.confirmationSessionId || '')
      && String(question.draftRevision || '') === String(this.draftRevision || '')
      && String(question.originalTextFingerprint || '') === originalTextFingerprint
      && String(context.confirmationSessionId || '') === String(question.confirmationSessionId || '')
      && String(context.draftRevision || '') === String(question.draftRevision || '')
      && String(context.originalTextFingerprint || '') === originalTextFingerprint;
    if (!identityValid) {
      const blockedState = buildSafeBlockedAnswerState(
        confirmationState,
        'ASSISTANT_REVIEW_IDENTITY_INVALID'
      );
      setConversationData(this, blockedState);
      return Promise.resolve({
        accepted: true,
        code: 'ASSISTANT_REVIEW_IDENTITY_INVALID',
        questionId: question.questionId
      });
    }

    const state = getState();
    const source = this.data.source || committedResult.source || 'typed';
    const routePayload = {
      businessDate: String(question.businessDate || context.businessDate || ''),
      context: 'home',
      entrySurface: 'FULL_PAGE',
      inputChannel: source === 'voice' ? 'VOICE_TRANSCRIPT' : (source === 'paste' ? 'PASTE_TEXT' : 'MANUAL_TEXT'),
      reviewMode: 'deep',
      source,
      state,
      text: canonicalText
    };
    let prepared;
    try {
      prepared = prepareHybridLocalStage(routePayload);
    } catch (error) {
      prepared = null;
    }
    if (!prepared || !prepared.route || prepared.route.decision !== ROUTE_AI_DEEP) {
      const blockedState = buildSafeBlockedAnswerState(
        confirmationState,
        'ASSISTANT_REVIEW_ROUTE_NOT_TRUSTED'
      );
      setConversationData(this, blockedState);
      return Promise.resolve({
        accepted: true,
        code: 'ASSISTANT_REVIEW_ROUTE_NOT_TRUSTED',
        questionId: question.questionId
      });
    }

    const identity = {
      businessDate: routePayload.businessDate,
      confirmationSessionId: String(question.confirmationSessionId || ''),
      draftRevision: String(question.draftRevision || ''),
      originalTextFingerprint,
      requestedRoute: 'AUTO_DEEP',
      requestId: nextClientRuntimeId(this, 'record-answer-review-request')
    };
    this.currentRequestedRoute = identity.requestedRoute;
    this.activeParseRequestToken = identity.requestId;
    this.activeParseIdentity = identity;
    setConversationData(this, Object.assign({}, confirmationState, {
      activeQuestion: null,
      assistantAnswerValue: '',
      assistantQuestionState: 'READY',
      assistantQuestions: [],
      disableFormalSave: true,
      parsing: true,
      parseAssistText: '正在核对你刚确认的内容。',
      parseButtonText: '正在识别',
      parseProgressDetail: '请稍等，确认前不会自动保存',
      parseProgressTitle: '正在核对关键信息',
      showParseProgress: true
    }));
    startParseProgress(this, source);

    const payload = Object.assign({}, routePayload, {
      confirmationSessionId: identity.confirmationSessionId,
      draftRevision: identity.draftRevision,
      extractedText: canonicalText,
      originalTextFingerprint: identity.originalTextFingerprint,
      pasteMeta: null,
      rawMessages: [],
      rawText: currentOriginalText,
      requestId: identity.requestId,
      requestedRoute: identity.requestedRoute
    });
    // The trusted answer replaces the raw stated total for the current draft,
    // while original_text remains untouched for audit. Keeping the old
    // statedAmount slot would falsely claim that the original 5000 text was
    // evidence for the newly confirmed 4676.1 value.
    const reviewedFields = Object.assign({}, committedFields, { statedAmount: '' });
    const reviewedResult = Object.assign({}, committedResult, { fields: reviewedFields });
    const requestPrepared = Object.assign({}, prepared, {
      localResult: Object.assign({}, reviewedResult, { parse_route: prepared.route }),
      localReviewedResult: reviewedResult,
      route: prepared.route,
      totalStartedAt: Date.now()
    });
    const operation = requestHybridAiStage(payload, requestPrepared)
      .then((parseResult) => {
        if (!isParseIdentityCurrent(this, identity)) {
          return { accepted: false, code: 'ANSWER_REVIEW_STALE', questionId: question.questionId };
        }
        invalidateActiveParseIdentity(this);
        clearParseProgress(this);
        const contextualResult = attachClientConfirmationContext(parseResult, identity);
        const nextState = buildConfirmationState(
          state,
          contextualResult,
          contextualResult.intent,
          contextualResult.fields
        );
        setConversationData(this, Object.assign({}, nextState, {
          intent: nextState.parseResult.intent,
          intentLabel: INTENT_LABELS[nextState.parseResult.intent],
          parsing: false,
          parseButtonText: '生成确认卡',
          showParseProgress: false
        }));
        return { accepted: true, questionId: question.questionId };
      })
      .catch(() => {
        if (!isParseIdentityCurrent(this, identity)) {
          return { accepted: false, code: 'ANSWER_REVIEW_STALE', questionId: question.questionId };
        }
        invalidateActiveParseIdentity(this);
        clearParseProgress(this);
        const blockedState = buildSafeBlockedAnswerState(
          confirmationState,
          'ASSISTANT_REVIEW_FAILED'
        );
        setConversationData(this, Object.assign({}, blockedState, {
          parsing: false,
          parseButtonText: '生成确认卡',
          showParseProgress: false
        }));
        return { accepted: true, code: 'ASSISTANT_REVIEW_FAILED', questionId: question.questionId };
      });
    return trackParseOperation(this, identity, operation);
  },

  requestDeepReview() {
    if (!this.data.parseResult) return null;
    const rejection = rejectNoRecordPageAction(
      this,
      this.data.parseResult,
      'NO_RECORD_DEEP_REVIEW_FORBIDDEN'
    );
    if (rejection) return rejection;
    return null;
  },

  updateAssistantAnswer(event) {
    this.setData({ assistantAnswerValue: String(event && event.detail && event.detail.value || '') });
  },

  submitAssistantAnswer(event) {
    const dataset = event && event.currentTarget && event.currentTarget.dataset || {};
    const result = this.answerAssistantQuestion({
      currentTarget: { dataset },
      detail: {
        target: {
          field: dataset.field || '',
          fieldPath: dataset.fieldPath || '',
          itemKey: dataset.itemKey || ''
        },
        value: this.data.assistantAnswerValue
      }
    });
    if (result && typeof result.then === 'function') {
      return result.then((settled) => {
        if (settled && settled.accepted) setConversationData(this, { assistantAnswerValue: '' });
        return settled;
      });
    }
    if (result && result.accepted) this.setData({ assistantAnswerValue: '' });
    return result;
  },

  answerAssistantQuestion(event) {
    const question = this.data.activeQuestion;
    const detail = event && event.detail || {};
    const dataset = event && event.currentTarget && event.currentTarget.dataset || {};
    const incomingTarget = detail.target || {};
    if (!question || question.status !== 'OPEN') return { accepted: false, code: 'QUESTION_NOT_OPEN' };
    const expectedTarget = question.target || {};
    const questionId = String(detail.questionId || dataset.questionId || '');
    const revision = String(detail.draftRevision || dataset.revision || '');
    const fingerprint = String(detail.originalTextFingerprint || dataset.originalTextFingerprint || '');
    const incomingField = String(incomingTarget.field || dataset.field || '');
    const incomingFieldPath = String(incomingTarget.fieldPath || dataset.fieldPath || '');
    const incomingItemKey = String(incomingTarget.itemKey || dataset.itemKey || '');
    const currentFingerprint = getOriginalTextFingerprint(getCurrentOriginalText(this));
    const currentSessionId = String(this.confirmationSessionId || '');
    const currentBusinessDate = String(this.confirmationBusinessDate || '');
    const valid = questionId === String(question.questionId || '')
      && revision === String(question.draftRevision || '')
      && revision === String(this.draftRevision || '')
      && fingerprint === String(question.originalTextFingerprint || '')
      && fingerprint === currentFingerprint
      && String(question.confirmationSessionId || '') === currentSessionId
      && String(question.businessDate || '') === currentBusinessDate
      && incomingField === String(expectedTarget.field || '')
      && incomingFieldPath === String(expectedTarget.fieldPath || '')
      && incomingItemKey === String(expectedTarget.itemKey || '');
    const rawAnswer = String(detail.value === undefined ? '' : detail.value).trim();
    if (!valid) return { accepted: false, code: 'QUESTION_STALE' };
    const answerValidation = normalizeAssistantQuestionAnswer(question, rawAnswer);
    if (!answerValidation.accepted) return answerValidation;

    let fields = Object.assign({}, this.data.fields || {});
    const baseResult = this.data.parseResult;
    const beforeProofState = evaluateUserResolvedAiState(baseResult);
    const challenge = createTrustedAssistantAnswerChallenge(baseResult, question);
    if (!challenge) return { accepted: false, code: 'QUESTION_AUTHORITY_INVALID' };
    const field = expectedTarget.field;
    const itemKey = String(expectedTarget.itemKey || '');
    const answer = answerValidation.value;
    if (itemKey) {
      const items = normalizeConfirmItems(fields, { ensureFirst: true });
      const itemIndex = items.findIndex((item) => String(item.confirmationItemKey || '') === itemKey);
      if (itemIndex < 0 || !MANUAL_ITEM_FIELDS.includes(field)) {
        return { accepted: false, code: 'QUESTION_TARGET_INVALID' };
      }
      items[itemIndex] = Object.assign({}, items[itemIndex], { [field]: answer });
      fields = syncFirstItemToLegacyFields(Object.assign({}, fields, { items }), {
        preserveConfirmedAmount: Array.isArray(baseResult.manual_fields)
          && baseResult.manual_fields.includes('amount')
      });
    } else {
      fields = field === 'amount'
        ? recalculateOrderAmountFields(fields, answer)
        : Object.assign({}, fields, { [field]: answer });
    }
    let stagedResult = createTrustedAssistantAnswerEdit(baseResult, { challenge, fields });
    const stagedProofState = evaluateUserResolvedAiState(Object.assign({}, stagedResult, { fields }));
    const questionRiskIds = uniqueFields(question.riskIds || []);
    if (!hasTrustedAssistantAnswerEdit(stagedResult, fields, question)
      || stagedProofState.trustedEditCount !== beforeProofState.trustedEditCount + 1
      || !questionRiskIds.every((riskId) => stagedProofState.resolvedRiskIds.includes(riskId))) {
      return { accepted: false, code: 'ANSWER_PROOF_REJECTED' };
    }
    if (itemKey) {
      stagedResult = Object.assign({}, stagedResult, {
        manual_item_fields: normalizeManualItemFields([].concat(
          Array.isArray(baseResult.manual_item_fields) ? baseResult.manual_item_fields : [],
          { itemKey, field }
        ), fields.items || [])
      });
    } else {
      stagedResult = Object.assign({}, stagedResult, {
        manual_fields: uniqueFields([].concat(
          Array.isArray(baseResult.manual_fields) ? baseResult.manual_fields : [],
          field
        ))
      });
    }
    stagedResult = Object.assign({}, stagedResult, {
      missing_fields: uniqueFields(stagedResult.missing_fields || []).filter((name) => name !== field),
      low_confidence_fields: uniqueFields(stagedResult.low_confidence_fields || []).filter((name) => name !== field)
    });
    // A real assistant answer consumes the active question in its current
    // confirmation context. Advancing the revision here would immediately
    // detach the newly issued proof from that question/context pair.
    let reviewedResult = rerouteClientDraft(stagedResult, fields);
    reviewedResult = attachCurrentDraftContext(this, reviewedResult);
    const reviewedFields = reviewedResult.fields || fields;
    const reviewedProofState = evaluateUserResolvedAiState(reviewedResult);
    if (!hasTrustedAssistantAnswerEdit(reviewedResult, reviewedFields, question)
      || reviewedProofState.trustedEditCount !== beforeProofState.trustedEditCount + 1
      || !questionRiskIds.every((riskId) => reviewedProofState.resolvedRiskIds.includes(riskId))) {
      return { accepted: false, code: 'ANSWER_PROOF_REJECTED' };
    }
    const nextRequestedRoute = getClientRouteName(reviewedResult)
      || this.currentRequestedRoute
      || 'ASK_USER';
    const confirmationState = buildConfirmationState(
      getState(),
      reviewedResult,
      reviewedResult.intent,
      reviewedResult.fields
    );
    const committedResult = confirmationState.parseResult;
    const committedFields = confirmationState.fields || committedResult.fields || reviewedFields;
    const committedProofState = evaluateUserResolvedAiState(committedResult);
    if (!hasTrustedAssistantAnswerEdit(committedResult, committedFields, question)
      || committedProofState.trustedEditCount !== beforeProofState.trustedEditCount + 1
      || !questionRiskIds.every((riskId) => committedProofState.resolvedRiskIds.includes(riskId))) {
      return { accepted: false, code: 'ANSWER_PROOF_REJECTED' };
    }
    if (['AI_DEEP', 'AUTO_DEEP'].includes(String(nextRequestedRoute || '').toUpperCase())) {
      this.startTrustedAssistantAnswerDeepReview(confirmationState, question);
      return {
        accepted: true,
        questionId: question.questionId,
        reviewRequested: true
      };
    }
    setConversationData(this, Object.assign({}, confirmationState, {
      intent: confirmationState.parseResult.intent,
      intentLabel: INTENT_LABELS[confirmationState.parseResult.intent],
      parsing: false,
      parseButtonText: '生成确认卡'
    }));
    this.currentRequestedRoute = nextRequestedRoute;
    return { accepted: true, questionId: question.questionId };
  },

  toggleParseEvidence() {
    this.setData({ showParseEvidence: !this.data.showParseEvidence });
  },

  toggleOriginalText() {
    this.setData({ originalTextExpanded: !this.data.originalTextExpanded });
  },

  closeConfirmCard() {
    const text = this.data.text;
    const source = this.data.source;
    invalidateRawInputCapture(this, 'CONFIRM_CARD_CLOSED');
    advanceDraftRevision(this, { newSession: true });
    clearParseProgress(this);
    this.setData(Object.assign(getEmptyConfirmationData(), {
      text,
      source,
      sourceLabel: INPUT_SOURCE_LABELS[source] || INPUT_SOURCE_LABELS.typed,
      parseButtonText: '生成确认卡',
      parseAssistText: text ? '已关闭确认卡，原内容还在输入框里。' : ''
    }, getSourceState(source)));
  },

  changeIntent(event) {
    const intent = intentOptions[Number(event.detail.value)];
    if (!this.data.parseResult) {
      this.setData({
        intent,
        intentLabel: INTENT_LABELS[intent]
      });
      return;
    }
    const state = getState();
    const intentChanged = intent !== this.data.intent;
    let fields;
    let baseResult;
    if (intentChanged) {
      fields = projectTypeSwitchFields(this.data.intent, intent, this.data.fields || {});
      baseResult = projectTypeSwitchResult(
        this.data.parseResult,
        this.data.intent,
        intent,
        this.data.fields || {}
      );
    } else {
      baseResult = Object.assign({}, this.data.parseResult, {
        intent,
        operation: this.data.parseResult.operation,
        missing_fields: uniqueFields(this.data.parseResult.missing_fields || [])
          .filter((item) => item !== 'intent'),
        low_confidence_fields: this.data.parseResult.low_confidence_fields || []
      });
      fields = this.data.quotationSelectionRootFields
        ? copyQuotationSelectionBaseFields(this.data.quotationSelectionRootFields)
        : (this.data.quotationSelectionBaseFields
          ? copyQuotationSelectionBaseFields(this.data.quotationSelectionBaseFields)
          : (this.data.orderSelectionBaseFields
            ? copyOrderSelectionBaseFields(this.data.orderSelectionBaseFields)
            : Object.assign({}, this.data.fields)));
      delete fields.quotationId;
      delete fields.quotationSelectionConfirmed;
    }
    baseResult = rebuildAfterClientDraftEdit(this, baseResult, fields);
    const confirmationState = buildConfirmationState(state, baseResult, intent, fields);
    this.setData(Object.assign({}, confirmationState, {
      intent,
      intentLabel: INTENT_LABELS[intent]
    }));
  },

  updateField(event) {
    const field = event.currentTarget.dataset.field;
    const patch = {};
    patch[`fields.${field}`] = event.detail.value;
    if (this.data.parseResult) {
      const hasGenericQuotationSelection = Boolean(
        this.data.selectedQuotationId && this.data.quotationSelectionBaseFields
      );
      const hasGenericOrderSelection = Boolean(
        this.data.selectedOrderId && this.data.orderSelectionBaseFields
      );
      const fieldInvalidatesOrderSelection = ['customerName', 'phone', 'productName'].includes(field);
      const fieldInvalidatesQuotationSelection = ['customerName', 'phone'].includes(field);
      const sourceFields = hasGenericQuotationSelection
        ? copyQuotationSelectionBaseFields(
          fieldInvalidatesQuotationSelection && this.data.quotationSelectionRootFields
            ? this.data.quotationSelectionRootFields
            : this.data.quotationSelectionBaseFields
        )
        : (hasGenericOrderSelection
          ? copyOrderSelectionBaseFields(this.data.orderSelectionBaseFields)
          : this.data.fields);
      let nextFields = Object.assign({}, sourceFields, {
        [field]: event.detail.value
      });
      if (field === 'amount' && this.data.intent === 'order') {
        nextFields = recalculateOrderAmountFields(nextFields, event.detail.value);
      }
      if (['customerName', 'phone'].includes(field)) {
        delete nextFields.customerId;
        delete nextFields.receivableId;
        delete nextFields.orderId;
        delete nextFields.allowUnlinkedPayment;
        delete nextFields.allowUnlinkedOrderDeposit;
        delete nextFields.unlinkedPaymentCustomerId;
        delete nextFields.unlinkedOrderDepositCustomerId;
        delete nextFields.receivableSelectionConfirmed;
        delete nextFields.orderSelectionConfirmed;
        delete nextFields.quotationId;
        delete nextFields.quotationSelectionConfirmed;
        delete nextFields.customerHistoryConfirmed;
        delete nextFields.customerSelectionConfirmed;
        if (field === 'customerName') delete nextFields.forceNewCustomer;
      }
      if (field === 'productName') {
        delete nextFields.orderId;
        delete nextFields.allowUnlinkedOrderDeposit;
        delete nextFields.unlinkedOrderDepositCustomerId;
        delete nextFields.orderSelectionConfirmed;
      }
      let baseResult = Object.assign({}, markManualField(this.data.parseResult, field, nextFields), {
        missing_fields: uniqueFields(this.data.parseResult.missing_fields || [])
          .filter((item) => item !== field),
        low_confidence_fields: uniqueFields(this.data.parseResult.low_confidence_fields || [])
          .filter((item) => item !== field)
      });
      baseResult = rebuildAfterClientDraftEdit(this, baseResult, nextFields);
      const state = getState();
      Object.assign(
        patch,
        hasGenericQuotationSelection && !fieldInvalidatesQuotationSelection
          ? rebuildAfterQuotationFieldEdit(
            state,
            this.data,
            baseResult,
            this.data.intent,
            nextFields
          )
          : (hasGenericOrderSelection && !fieldInvalidatesOrderSelection
          ? rebuildAfterGenericOrderFieldEdit(
            state,
            this.data,
            baseResult,
            this.data.intent,
            nextFields
          )
          : buildConfirmationState(state, baseResult, this.data.intent, nextFields))
      );
    }
    this.setData(patch);
  },

  updateItemField(event) {
    if (!this.data.parseResult) return;
    const displayedItems = normalizeConfirmItems(this.data.fields, { ensureFirst: true });
    const index = resolveConfirmationItemIndex(displayedItems, event.currentTarget.dataset || {});
    const field = event.currentTarget.dataset.field;
    const hasQuotationSelection = Boolean(
      this.data.selectedQuotationId && this.data.quotationSelectionBaseFields
    );
    if (!displayedItems[index] || !field) return;
    const value = ['unit', 'priceUnit'].includes(field) ? normalizeUnit(event.detail.value) : event.detail.value;
    const manualFields = Array.isArray(this.data.parseResult.manual_fields)
      ? this.data.parseResult.manual_fields
      : [];
    const currentItemKey = displayedItems[index].confirmationItemKey;
    const manualItemFields = normalizeManualItemFields(
      this.data.parseResult.manual_item_fields,
      displayedItems
    );
    const hasManualItemTotal = manualItemFields.some((entry) => (
      entry.itemKey === currentItemKey && entry.field === 'totalAmount'
    ));
    const nextDisplayedItem = Object.assign({}, displayedItems[index], {
      [field]: value
    });
    if (['quantity', 'unit', 'unitPrice', 'priceUnit'].includes(field)
      && !hasManualItemTotal
      && hasMoneyValue(nextDisplayedItem.quantity)
      && hasMoneyValue(nextDisplayedItem.unitPrice)) {
      nextDisplayedItem.totalAmount = unitsMatch(nextDisplayedItem.unit, nextDisplayedItem.priceUnit)
        ? formatMoneyValue(Number(nextDisplayedItem.quantity) * Number(nextDisplayedItem.unitPrice))
        : '';
    }
    const nextConfirmationItems = displayedItems.slice();
    nextConfirmationItems[index] = nextDisplayedItem;
    let fields;
    if (hasQuotationSelection) {
      fields = copyQuotationSelectionBaseFields(this.data.quotationSelectionBaseFields);
      const itemPatches = Array.isArray(fields.items)
        ? fields.items.map((item) => Object.assign({}, item))
        : [];
      while (itemPatches.length <= index) itemPatches.push({});
      const existingPatch = itemPatches[index][QUOTATION_ITEM_REMOVED] === true
        ? {}
        : itemPatches[index];
      itemPatches[index] = Object.assign({}, existingPatch, {
        confirmationItemKey: currentItemKey,
        [field]: value
      });
      if (Object.prototype.hasOwnProperty.call(nextDisplayedItem, 'totalAmount')) {
        itemPatches[index].totalAmount = nextDisplayedItem.totalAmount;
      }
      fields.items = itemPatches;
    } else {
      fields = syncFirstItemToLegacyFields(Object.assign({}, this.data.fields, {
        items: nextConfirmationItems
      }), {
        preserveConfirmedAmount: manualFields.includes('amount')
      });
    }
    if (field === 'productName') {
      delete fields.orderId;
      delete fields.allowUnlinkedOrderDeposit;
      delete fields.orderSelectionConfirmed;
    }
    const normalizedItems = normalizeConfirmItems({ items: nextConfirmationItems }, { ensureFirst: true });
    const proofFields = syncFirstItemToLegacyFields(Object.assign({}, this.data.fields, {
      items: normalizedItems
    }), {
      preserveConfirmedAmount: manualFields.includes('amount')
    });
    let baseResult = markManualItemField(this.data.parseResult, proofFields, currentItemKey, field);
    baseResult = pruneItemProvenance(baseResult, normalizedItems);
    baseResult = hasQuotationSelection
      ? (advanceDraftRevision(this), attachCurrentDraftContext(this, baseResult))
      : rebuildAfterClientDraftEdit(this, baseResult, fields);
    const state = getState();
    this.setData(
      hasQuotationSelection
        ? rebuildAfterQuotationFieldEdit(
          state,
          this.data,
          baseResult,
          this.data.intent,
          fields
        )
        : buildConfirmationState(state, baseResult, this.data.intent, fields)
    );
  },

  changeFollowupDays(event) {
    if (!this.data.parseResult) return;
    const days = FOLLOWUP_DAY_VALUES[Number(event.detail.value)] || DEFAULT_QUOTATION_FOLLOWUP_DAYS;
    const sourceFields = this.data.quotationSelectionBaseFields
      ? copyQuotationSelectionBaseFields(this.data.quotationSelectionBaseFields)
      : this.data.fields;
    const fields = Object.assign({}, sourceFields, {
      followupDays: String(days)
    });
    let baseResult = Object.assign({}, this.data.parseResult, {
      missing_fields: uniqueFields(this.data.parseResult.missing_fields || [])
        .filter((item) => !['followupDays', 'dueDate'].includes(item)),
      low_confidence_fields: uniqueFields(this.data.parseResult.low_confidence_fields || [])
        .filter((item) => !['followupDays', 'dueDate'].includes(item))
    });
    baseResult = rebuildAfterCandidateFactChange(this, baseResult);
    const state = getState();
    this.setData(
      this.data.selectedQuotationId && this.data.quotationSelectionBaseFields
        ? rebuildAfterQuotationFieldEdit(
          state,
          this.data,
          baseResult,
          this.data.intent,
          fields
        )
        : buildConfirmationState(state, baseResult, this.data.intent, fields)
    );
  },

  changeDateField(event) {
    const field = event.currentTarget.dataset.field || 'dueDate';
    const value = event.detail.value;
    const patch = {};
    patch[`fields.${field}`] = value;
    if (this.data.parseResult) {
      const hasGenericQuotationSelection = Boolean(
        this.data.selectedQuotationId && this.data.quotationSelectionBaseFields
      );
      const hasGenericOrderSelection = Boolean(
        this.data.selectedOrderId && this.data.orderSelectionBaseFields
      );
      const sourceFields = hasGenericQuotationSelection
        ? copyQuotationSelectionBaseFields(this.data.quotationSelectionBaseFields)
        : (hasGenericOrderSelection
          ? copyOrderSelectionBaseFields(this.data.orderSelectionBaseFields)
          : this.data.fields);
      const nextFields = Object.assign({}, sourceFields, {
        [field]: value
      });
      if (field === 'dueDate' && this.data.operation === 'record_payment') {
        nextFields.paymentDate = value;
      }
      let baseResult = Object.assign({}, markManualField(this.data.parseResult, field, nextFields), {
        missing_fields: uniqueFields(this.data.parseResult.missing_fields || [])
          .filter((item) => item !== field),
        low_confidence_fields: uniqueFields(this.data.parseResult.low_confidence_fields || [])
          .filter((item) => item !== field)
      });
      baseResult = rebuildAfterClientDraftEdit(this, baseResult, nextFields);
      const state = getState();
      Object.assign(
        patch,
        hasGenericQuotationSelection
          ? rebuildAfterQuotationFieldEdit(
            state,
            this.data,
            baseResult,
            this.data.intent,
            nextFields
          )
          : (hasGenericOrderSelection
          ? rebuildAfterGenericOrderFieldEdit(
            state,
            this.data,
            baseResult,
            this.data.intent,
            nextFields
          )
          : buildConfirmationState(state, baseResult, this.data.intent, nextFields))
      );
    }
    this.setData(patch);
  },

  changeCustomerMatch(event) {
    if (!this.data.parseResult) return;
    const selected = this.data.customerMatchOptions[Number(event.detail.value)];
    if (!selected) return;
    const fields = this.data.quotationSelectionRootFields
      ? copyQuotationSelectionBaseFields(this.data.quotationSelectionRootFields)
      : (this.data.quotationSelectionBaseFields
        ? copyQuotationSelectionBaseFields(this.data.quotationSelectionBaseFields)
        : Object.assign({}, this.data.fields));
    delete fields.receivableId;
    delete fields.orderId;
    delete fields.quotationId;
    delete fields.allowUnlinkedPayment;
    delete fields.allowUnlinkedOrderDeposit;
    delete fields.unlinkedPaymentCustomerId;
    delete fields.unlinkedOrderDepositCustomerId;
    delete fields.receivableSelectionConfirmed;
    delete fields.orderSelectionConfirmed;
    delete fields.quotationSelectionConfirmed;
    if (selected.id === NEW_CUSTOMER_OPTION_ID) {
      delete fields.customerId;
      delete fields.customerSelectionConfirmed;
      fields.forceNewCustomer = true;
    } else {
      fields.customerId = selected.id;
      fields.customerSelectionConfirmed = true;
      delete fields.forceNewCustomer;
    }
    delete fields.customerHistoryConfirmed;
    let baseResult = Object.assign({}, this.data.parseResult, {
      missing_fields: uniqueFields(this.data.parseResult.missing_fields || [])
        .filter((item) => !['customerName', 'customerId'].includes(item)),
      low_confidence_fields: this.data.parseResult.low_confidence_fields || []
    });
    baseResult = rebuildAfterCandidateFactChange(this, baseResult);
    const state = getState();
    this.setData(buildConfirmationState(state, baseResult, this.data.intent, fields));
  },

  confirmCustomerHistory() {
    if (!this.data.parseResult) return;
    const fields = Object.assign({}, this.data.fields, {
      customerHistoryConfirmed: true
    });
    let baseResult = Object.assign({}, this.data.parseResult, {
      missing_fields: uniqueFields(this.data.parseResult.missing_fields || []),
      low_confidence_fields: this.data.parseResult.low_confidence_fields || []
    });
    baseResult = rebuildAfterCandidateFactChange(this, baseResult);
    const state = getState();
    this.setData(buildConfirmationState(state, baseResult, this.data.intent, fields));
  },

  createNewCustomerOrder() {
    if (!this.data.parseResult) return;
    const fields = this.data.quotationSelectionRootFields
      ? copyQuotationSelectionBaseFields(this.data.quotationSelectionRootFields)
      : (this.data.quotationSelectionBaseFields
        ? copyQuotationSelectionBaseFields(this.data.quotationSelectionBaseFields)
        : Object.assign({}, this.data.fields));
    delete fields.customerId;
    delete fields.receivableId;
    delete fields.orderId;
    delete fields.quotationId;
    delete fields.allowUnlinkedPayment;
    delete fields.allowUnlinkedOrderDeposit;
    delete fields.unlinkedPaymentCustomerId;
    delete fields.unlinkedOrderDepositCustomerId;
    delete fields.receivableSelectionConfirmed;
    delete fields.orderSelectionConfirmed;
    delete fields.quotationSelectionConfirmed;
    delete fields.customerHistoryConfirmed;
    delete fields.customerSelectionConfirmed;
    fields.forceNewCustomer = true;
    let baseResult = Object.assign({}, this.data.parseResult, {
      missing_fields: uniqueFields(this.data.parseResult.missing_fields || []),
      low_confidence_fields: this.data.parseResult.low_confidence_fields || []
    });
    baseResult = rebuildAfterCandidateFactChange(this, baseResult);
    const state = getState();
    this.setData(buildConfirmationState(state, baseResult, this.data.intent, fields));
    wx.showToast({
      title: '建议更换客户称呼，或补手机号/备注来区分客户',
      icon: 'none'
    });
  },

  changeReceivable(event) {
    if (!this.data.parseResult) return;
    const selected = this.data.receivableOptions[Number(event.detail.value)];
    if (!selected) return;
    const fields = Object.assign({}, this.data.fields, {
      receivableId: selected.id
    });
    if (selected.id === UNLINKED_RECEIVABLE_OPTION_ID) {
      delete fields.receivableSelectionConfirmed;
    } else {
      delete fields.allowUnlinkedPayment;
      delete fields.unlinkedPaymentCustomerId;
      fields.receivableSelectionConfirmed = true;
    }
    let baseResult = Object.assign({}, this.data.parseResult, {
      missing_fields: uniqueFields(this.data.parseResult.missing_fields || [])
        .filter((item) => item !== 'receivableId'),
      low_confidence_fields: this.data.parseResult.low_confidence_fields || []
    });
    baseResult = rebuildAfterCandidateFactChange(this, baseResult);
    const state = getState();
    this.setData(buildConfirmationState(state, baseResult, this.data.intent, fields));
  },

  changeOrderDeposit(event) {
    if (!this.data.parseResult) return;
    const selected = this.data.orderOptions[Number(event.detail.value)];
    if (!selected) return;
    const fields = Object.assign({}, this.data.fields, {
      orderId: selected.id
    });
    if (selected.id === UNLINKED_ORDER_OPTION_ID) {
      delete fields.orderSelectionConfirmed;
    } else {
      delete fields.allowUnlinkedOrderDeposit;
      delete fields.unlinkedOrderDepositCustomerId;
      fields.orderSelectionConfirmed = true;
    }
    let baseResult = Object.assign({}, this.data.parseResult, {
      missing_fields: uniqueFields(this.data.parseResult.missing_fields || [])
        .filter((item) => item !== 'orderId'),
      low_confidence_fields: this.data.parseResult.low_confidence_fields || []
    });
    baseResult = rebuildAfterCandidateFactChange(this, baseResult);
    const state = getState();
    this.setData(buildConfirmationState(state, baseResult, this.data.intent, fields));
  },

  applyOrderSelection(orderId) {
    if (!this.data.parseResult) return false;
    const selectedId = String(orderId || '');
    const operationAllowsGenericOrder = [
      'update_order',
      'create_receivable',
      'create_receivable_with_payment'
    ].includes(this.data.operation);
    if (!operationAllowsGenericOrder
      || !this.data.showGenericOrderSelection
      || !this.data.showGenericOrderPicker) {
      wx.showToast({ title: '当前不需要选择订单', icon: 'none' });
      return false;
    }
    const projected = (this.data.orderCandidates || []).find((item) => item.id === selectedId);
    const state = getState();
    const liveOrder = (state.orders || []).find((item) => item.id === selectedId);
    const currentCustomerId = String((this.data.fields || {}).customerId || '');
    const valid = Boolean(
      projected
      && liveOrder
      && activeOrderStatuses.includes(liveOrder.status)
      && (!currentCustomerId || liveOrder.customerId === currentCustomerId)
    );
    if (!valid) {
      const baseResult = Object.assign({}, this.data.parseResult, {
        missing_fields: this.data.parseResult.missing_fields || [],
        low_confidence_fields: this.data.parseResult.low_confidence_fields || []
      });
      this.setData(buildConfirmationState(state, baseResult, this.data.intent, this.data.fields));
      wx.showToast({ title: '这张订单已不可选，请重新确认', icon: 'none' });
      return false;
    }
    const baseFields = this.data.orderSelectionBaseFields
      ? copyOrderSelectionBaseFields(this.data.orderSelectionBaseFields)
      : copyOrderSelectionBaseFields(this.data.fields);
    const fields = Object.assign({}, baseFields, {
      orderId: liveOrder.id,
      orderSelectionConfirmed: true
    });
    let baseResult = Object.assign({}, this.data.parseResult, {
      missing_fields: uniqueFields(this.data.parseResult.missing_fields || [])
        .filter((field) => field !== 'orderId'),
      low_confidence_fields: uniqueFields(this.data.parseResult.low_confidence_fields || [])
        .filter((field) => field !== 'orderId')
    });
    baseResult = rebuildAfterCandidateFactChange(this, baseResult);
    const confirmationState = retainOrderCandidateChoices(
      state,
      buildConfirmationState(state, baseResult, this.data.intent, fields),
      this.data.orderCandidates,
      liveOrder.id
    );
    confirmationState.orderSelectionBaseFields = baseFields;
    this.setData(confirmationState);
    return true;
  },

  changeOrder(event) {
    const selected = (this.data.orderOptions || [])[Number(event.detail.value)];
    if (!selected) return false;
    return this.applyOrderSelection(selected.id);
  },

  selectOrderCandidate(event) {
    return this.applyOrderSelection(event.currentTarget.dataset.orderId);
  },

  clearOrderSelection() {
    if (!this.data.parseResult) return;
    const fields = this.data.orderSelectionBaseFields
      ? copyOrderSelectionBaseFields(this.data.orderSelectionBaseFields)
      : Object.assign({}, this.data.fields);
    delete fields.orderId;
    delete fields.orderSelectionConfirmed;
    let baseResult = Object.assign({}, this.data.parseResult, {
      missing_fields: this.data.parseResult.missing_fields || [],
      low_confidence_fields: this.data.parseResult.low_confidence_fields || []
    });
    baseResult = rebuildAfterCandidateFactChange(this, baseResult);
    this.setData(buildConfirmationState(getState(), baseResult, this.data.intent, fields));
  },

  applyQuotationSelection(quotationId) {
    if (!this.data.parseResult) return false;
    const selectedId = String(quotationId || '');
    if (!['update_quotation', 'create_order'].includes(this.data.operation)
      || !this.data.showGenericQuotationSelection
      || !this.data.showGenericQuotationPicker) {
      wx.showToast({ title: '当前不需要选择报价', icon: 'none' });
      return false;
    }
    const state = getState();
    const currentSelectedId = String(this.data.selectedQuotationId || '');
    const rootFields = this.data.quotationSelectionRootFields
      ? copyQuotationSelectionBaseFields(this.data.quotationSelectionRootFields)
      : (this.data.quotationSelectionBaseFields
        ? copyQuotationSelectionBaseFields(this.data.quotationSelectionBaseFields)
        : copyQuotationSelectionBaseFields(this.data.fields));
    const currentBaseFields = currentSelectedId && this.data.quotationSelectionBaseFields
      ? copyQuotationSelectionBaseFields(this.data.quotationSelectionBaseFields)
      : copyQuotationSelectionBaseFields(rootFields);
    const baseFields = currentSelectedId && currentSelectedId === selectedId
      ? copyQuotationSelectionBaseFields(currentBaseFields)
      : copyQuotationSelectionBaseFields(rootFields);
    let baseResult = Object.assign({}, this.data.parseResult, {
      missing_fields: uniqueFields(this.data.parseResult.missing_fields || [])
        .filter((field) => field !== 'quotationId'),
      low_confidence_fields: uniqueFields(this.data.parseResult.low_confidence_fields || [])
        .filter((field) => field !== 'quotationId')
    });
    const freshSelectionState = buildConfirmationState(
      state,
      baseResult,
      this.data.intent,
      baseFields
    );
    const freshCandidate = (freshSelectionState.quotationCandidates || [])
      .find((item) => item.id === selectedId);
    if (!freshCandidate) {
      const currentStillSafe = (freshSelectionState.quotationCandidates || [])
        .some((item) => item.id === currentSelectedId);
      if (currentStillSafe) {
        const retainedState = buildConfirmationState(
          state,
          baseResult,
          this.data.intent,
          mergeQuotationSelectionDraftFields(state, currentBaseFields, currentSelectedId)
        );
        retainedState.quotationSelectionBaseFields = currentBaseFields;
        retainedState.quotationSelectionRootFields = rootFields;
        this.setData(retainedState);
      } else {
        this.setData(freshSelectionState);
      }
      wx.showToast({ title: '这张报价已不可选，请重新确认', icon: 'none' });
      return false;
    }
    const fields = mergeQuotationSelectionDraftFields(
      state,
      baseFields,
      freshCandidate.id
    );
    let confirmationState = buildConfirmationState(
      state,
      baseResult,
      this.data.intent,
      fields
    );
    const accepted = (confirmationState.quotationCandidates || [])
      .some((item) => item.id === selectedId)
      && String((confirmationState.fields || {}).quotationId || '') === selectedId;
    if (!accepted) {
      this.setData(freshSelectionState);
      wx.showToast({ title: '这张报价已不可选，请重新确认', icon: 'none' });
      return false;
    }
    baseResult = rebuildAfterCandidateFactChange(this, baseResult);
    confirmationState = buildConfirmationState(
      state,
      baseResult,
      this.data.intent,
      fields
    );
    confirmationState.quotationSelectionBaseFields = baseFields;
    confirmationState.quotationSelectionRootFields = rootFields;
    confirmationState.quotationSelectionConfirmed = true;
    this.setData(confirmationState);
    return true;
  },

  changeQuotation(event) {
    const selected = (this.data.quotationOptions || [])[Number(event.detail.value)];
    if (!selected) return false;
    return this.applyQuotationSelection(selected.id);
  },

  selectQuotationCandidate(event) {
    return this.applyQuotationSelection(event.currentTarget.dataset.quotationId);
  },

  clearQuotationSelection() {
    if (!this.data.parseResult) return false;
    const fields = this.data.quotationSelectionRootFields
      ? copyQuotationSelectionBaseFields(this.data.quotationSelectionRootFields)
      : (this.data.quotationSelectionBaseFields
        ? copyQuotationSelectionBaseFields(this.data.quotationSelectionBaseFields)
        : copyQuotationSelectionBaseFields(this.data.fields));
    let baseResult = Object.assign({}, this.data.parseResult, {
      missing_fields: this.data.parseResult.missing_fields || [],
      low_confidence_fields: this.data.parseResult.low_confidence_fields || []
    });
    baseResult = rebuildAfterCandidateFactChange(this, baseResult);
    this.setData(buildConfirmationState(
      getState(),
      baseResult,
      this.data.intent,
      fields
    ));
    return true;
  },

  addConfirmItem() {
    if (!this.data.parseResult) return;
    const hasQuotationSelection = Boolean(
      this.data.selectedQuotationId && this.data.quotationSelectionBaseFields
    );
    const items = normalizeConfirmItems(this.data.parseResult.fields || {}, { ensureFirst: true });
    const previous = items[items.length - 1] || {};
    const addedItem = normalizeConfirmItem({
      productName: previous.productName || '',
      unit: previous.unit || '',
      unitPrice: previous.unitPrice || '',
      priceUnit: previous.priceUnit || previous.unit || ''
    });
    const normalizedItems = normalizeConfirmItems({
      items: items.concat(addedItem)
    }, { ensureFirst: true });
    const normalizedAddedItem = normalizedItems[normalizedItems.length - 1];
    let fields;
    if (hasQuotationSelection) {
      fields = copyQuotationSelectionBaseFields(this.data.quotationSelectionBaseFields);
      const itemPatches = Array.isArray(fields.items)
        ? fields.items.map((item) => Object.assign({}, item))
        : [];
      while (itemPatches.length < items.length) itemPatches.push({});
      itemPatches.push(normalizedAddedItem);
      fields.items = itemPatches;
    } else {
      fields = syncFirstItemToLegacyFields(Object.assign({}, this.data.parseResult.fields || {}, {
        items: normalizedItems
      }));
    }
    let baseResult = pruneItemProvenance(this.data.parseResult, normalizedItems);
    baseResult = reconcileTrustedUserManualEditState(baseResult, fields, {
      action: 'ADD_ITEM',
      itemKey: normalizedAddedItem.confirmationItemKey
    });
    if (hasQuotationSelection) {
      advanceDraftRevision(this);
      baseResult = attachCurrentDraftContext(this, baseResult);
    } else {
      baseResult = rebuildAfterClientDraftEdit(this, baseResult, fields);
    }
    this.setData(
      hasQuotationSelection
        ? rebuildAfterQuotationFieldEdit(
          getState(),
          this.data,
          baseResult,
          this.data.intent,
          fields
        )
        : buildConfirmationState(getState(), baseResult, this.data.intent, fields)
    );
  },

  removeConfirmItem(event) {
    if (!this.data.parseResult) return;
    const hasQuotationSelection = Boolean(
      this.data.selectedQuotationId && this.data.quotationSelectionBaseFields
    );
    const items = normalizeConfirmItems(this.data.parseResult.fields || {}, { ensureFirst: true });
    const index = resolveConfirmationItemIndex(items, event.currentTarget.dataset || {});
    if (items.length <= 1 || !items[index]) return;
    const remainingItems = items.filter((item, itemIndex) => itemIndex !== index);
    let fields;
    if (hasQuotationSelection) {
      fields = copyQuotationSelectionBaseFields(this.data.quotationSelectionBaseFields);
      const itemPatches = Array.isArray(fields.items)
        ? fields.items.map((item) => Object.assign({}, item))
        : [];
      while (itemPatches.length <= index) itemPatches.push({});
      itemPatches[index] = {
        [QUOTATION_ITEM_REMOVED]: true
      };
      fields.items = itemPatches;
    } else {
      fields = syncFirstItemToLegacyFields(Object.assign({}, this.data.parseResult.fields || {}, {
        items: remainingItems
      }));
    }
    const normalizedItems = normalizeConfirmItems({ items: remainingItems }, { ensureFirst: true });
    let baseResult = pruneItemProvenance(this.data.parseResult, normalizedItems);
    baseResult = reconcileTrustedUserManualEditState(baseResult, fields, {
      action: 'REMOVE_ITEM',
      itemKey: String(items[index].confirmationItemKey || '')
    });
    if (hasQuotationSelection) {
      advanceDraftRevision(this);
      baseResult = attachCurrentDraftContext(this, baseResult);
    } else {
      baseResult = rebuildAfterClientDraftEdit(this, baseResult, fields);
    }
    this.setData(
      hasQuotationSelection
        ? rebuildAfterQuotationFieldEdit(
          getState(),
          this.data,
          baseResult,
          this.data.intent,
          fields
        )
        : buildConfirmationState(getState(), baseResult, this.data.intent, fields)
    );
  },

  applyProductSuggestion(event) {
    const value = event.currentTarget.dataset.value;
    if (!this.data.parseResult || !value) return;
    const items = normalizeConfirmItems(this.data.fields, { ensureFirst: false });
    if (items.length) {
      this.updateItemField({
        currentTarget: { dataset: { index: 0, field: 'productName' } },
        detail: { value }
      });
      return;
    }
    this.updateField({
      currentTarget: { dataset: { field: 'productName' } },
      detail: { value }
    });
  },

  applyCatalogProduct(event) {
    const index = Number(event.currentTarget.dataset.index || 0);
    const itemKey = event.currentTarget.dataset.itemKey || '';
    const value = event.currentTarget.dataset.value;
    if (!value) return;
    this.updateItemField({
      currentTarget: { dataset: { index, itemKey, field: 'productName' } },
      detail: { value }
    });
  },

  applyCatalogSpec(event) {
    const index = Number(event.currentTarget.dataset.index || 0);
    const itemKey = event.currentTarget.dataset.itemKey || '';
    const value = event.currentTarget.dataset.value;
    if (!value) return;
    this.updateItemField({
      currentTarget: { dataset: { index, itemKey, field: 'spec' } },
      detail: { value }
    });
  },

  returnToInput() {
    invalidateRawInputCapture(this, 'RETURN_TO_RAW_INPUT');
    const source = this.data.source || 'typed';
    advanceDraftRevision(this, { newSession: true });
    clearParseProgress(this);
    this.setData(Object.assign(getEmptyConfirmationData(), {
      text: this.data.text,
      source,
      sourceLabel: INPUT_SOURCE_LABELS[source] || INPUT_SOURCE_LABELS.typed,
      editingPendingId: this.data.editingPendingId,
      parseAssistText: '已返回原内容，可修改后重新识别。'
    }, getSourceState(source)));
  },

  saveFormal() {
    if (!this.data.parseResult || !canRunConfirmationSave(this)) {
      return { accepted: false, code: 'CONVERSATION_NOT_CONFIRMING' };
    }
    const state = getState();
    const baseResult = Object.assign({}, this.data.parseResult, {
      missing_fields: this.data.parseResult.missing_fields || [],
      low_confidence_fields: this.data.parseResult.low_confidence_fields || []
    });
    const confirmationState = buildConfirmationState(state, baseResult, this.data.intent, this.data.fields);
    const rejection = rejectNoRecordPageAction(
      this,
      confirmationState.parseResult,
      'NO_RECORD_FORMAL_SAVE_FORBIDDEN'
    );
    if (rejection) {
      this.setData(Object.assign({}, confirmationState, {
        lastNoRecordActionRejection: rejection
      }));
      return rejection;
    }
    if (confirmationState.disableFormalSave) {
      const quotationConflictText = (confirmationState.preflightBlockingReasons || [])
        .includes('QUOTATION_ORDER_RELATION_CONFLICT')
        ? confirmationState.quotationSelectionReason
        : '';
      const missingText = confirmationState.customerMatchWarningText
        || quotationConflictText
        || (confirmationState.showFieldConflicts ? '先确认聊天里的冲突信息' : '')
        || confirmationState.warningMissingText
        || confirmationState.warningLowText
        || '关键信息';
      this.setData(confirmationState);
      wx.showToast({
        title: quotationConflictText
          ? quotationConflictText
          : (missingText.startsWith('系统里') || missingText.startsWith('如果这是') || missingText.startsWith('这个客户')
          ? missingText
          : `请先补齐${missingText}`),
        icon: 'none'
      });
      return;
    }
    this.savingInProgress = true;
    let committed = false;
    try {
      setConversationData(this, {
        saving: true,
        showParseProgress: true,
        parseProgressTitle: '正在保存',
        parseProgressDetail: '请稍等，这笔记录只会保存一次'
      });
      const result = confirmationState.parseResult;
      const saved = saveConfirmedDraft(state, result);
      if (saved.type === 'error') {
        wx.showToast({
          title: saved.error || '订单没有更新，请核对后重试',
          icon: 'none'
        });
        return;
      }
      if (saved.type === 'pending' && this.data.editingPendingId) {
        const original = updatePendingNote(state, this.data.editingPendingId, result, (saved.record && saved.record.reason) || '信息仍不完整，需要稍后整理');
        if (original && saved.record && saved.record.id && saved.record.id !== original.id) {
          state.pendingNotes = (state.pendingNotes || []).filter((item) => item.id !== saved.record.id);
        }
      } else {
        markPendingNoteConverted(state, this.data.editingPendingId, saved);
      }
      saveState(state, { writerSource: 'INPUT_FORMAL' });
      committed = true;
      wx.showToast({
        title: saved.type === 'pending' ? '已存到待整理' : '已保存',
        icon: 'success'
      });
    } catch (error) {
      showFormalSaveToast({
        title: committed ? '已保存，可到记录里查看' : '保存失败，请稍后重试',
        icon: committed ? 'success' : 'none'
      });
      throw error;
    } finally {
      finalizeFormalSavePresentation(this, committed);
    }
  },

  savePending() {
    if (!this.data.parseResult || !canRunPendingSave(this)) {
      return { accepted: false, code: 'CONVERSATION_PENDING_UNAVAILABLE' };
    }
    const state = getState();
    const baseResult = Object.assign({}, this.data.parseResult, {
      missing_fields: this.data.parseResult.missing_fields || [],
      low_confidence_fields: this.data.parseResult.low_confidence_fields || []
    });
    const confirmationState = buildConfirmationState(state, baseResult, this.data.intent, this.data.fields);
    const rejection = rejectNoRecordPageAction(
      this,
      confirmationState.parseResult,
      'NO_RECORD_PENDING_SAVE_FORBIDDEN'
    );
    if (rejection) {
      this.setData(Object.assign({}, confirmationState, {
        lastNoRecordActionRejection: rejection
      }));
      return rejection;
    }
    if (confirmationState.domainCanSavePending !== true) {
      this.setData(confirmationState);
      wx.showToast({ title: '当前内容不能存到待整理', icon: 'none' });
      return {
        blocked: true,
        code: 'PENDING_SAVE_NOT_ELIGIBLE'
      };
    }
    this.savingInProgress = true;
    setConversationData(this, {
      saving: true,
      showParseProgress: true,
      parseProgressTitle: '正在保存',
      parseProgressDetail: '请稍等，这笔内容只会保存一次'
    });
    const reason = confirmationState.parseResult.history_warning_text || '用户选择稍后整理';
    const existingPending = updatePendingNote(state, this.data.editingPendingId, confirmationState.parseResult, reason);
    if (!existingPending) savePendingNote(state, confirmationState.parseResult, reason);
    saveState(state, { writerSource: 'INPUT_PENDING' });
    wx.showToast({ title: '已存到待整理', icon: 'success' });
    this.savingInProgress = false;
    this.setData(getEmptyConfirmationData());
  }
});
