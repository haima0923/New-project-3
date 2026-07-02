const { saveConfirmedDraft, savePendingNote } = require('../../utils/business');
const { INPUT_SOURCE_LABELS, INTENT_LABELS } = require('../../utils/constants');
const { parseHybridInput } = require('../../utils/ai-parser');
const { buildRecentRecords, buildTodayTasks } = require('../../utils/home-workbench');
const { requestOrderFilterReset, setNextOrderFilter, setNextRecordFilter } = require('../../utils/navigation-state');
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
  todo: ['todoTitle', 'customerName', 'productName', 'quantity', 'unit', 'unitPrice', 'amount', 'dueDate', 'remark'],
  unknown: ['remark']
};

const requiredFieldsByIntent = {
  quotation: ['customerName', 'productName'],
  order: ['customerName', 'productName', 'dueDate'],
  receivable: ['customerName', 'amount', 'dueDate'],
  payment: ['customerName', 'paymentAmount', 'receivableId'],
  todo: ['todoTitle', 'dueDate']
};

const requiredFieldsByOperation = {
  create_quotation: ['customerName', 'productName'],
  create_order: ['customerName', 'productName', 'dueDate'],
  create_receivable: ['customerName', 'amount', 'dueDate'],
  create_receivable_with_payment: ['customerName', 'amount', 'paymentAmount', 'dueDate'],
  record_payment: ['customerName', 'paymentAmount', 'receivableId'],
  record_order_deposit: ['customerName', 'paymentAmount', 'orderId'],
  create_todo: ['todoTitle', 'dueDate']
};

const digitFields = ['quantity', 'unitPrice', 'amount', 'depositAmount', 'paymentAmount', 'remainingAmount'];
const dateFields = ['dueDate'];
const VOICE_HOLD_DELAY_MS = 260;

function uniqueFields(fields) {
  return (fields || []).filter((field, index, array) => field && array.indexOf(field) === index);
}

function hasFieldValue(fields, field) {
  return fields && fields[field] !== undefined && fields[field] !== null && fields[field] !== '';
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

function normalizeEditableParseResult(parseResult) {
  const fields = parseResult.fields || {};
  const requiredFields = requiredFieldsByOperation[parseResult.operation] || requiredFieldsByIntent[parseResult.intent] || [];
  const missingFields = uniqueFields([]
    .concat(parseResult.missing_fields || [])
    .concat(requiredFields))
    .filter((field) => (isVisibleField(field) ? !hasFieldValue(fields, field) : true));
  return Object.assign({}, parseResult, {
    fields,
    missing_fields: missingFields,
    low_confidence_fields: uniqueFields(parseResult.low_confidence_fields || [])
  });
}

function buildConfirmFields(parseResult) {
  const normalized = normalizeEditableParseResult(parseResult);
  const fields = normalized.fields || {};
  const missingMap = (normalized.missing_fields || []).reduce((map, field) => {
    map[field] = true;
    return map;
  }, {});
  const lowMap = (normalized.low_confidence_fields || []).reduce((map, field) => {
    map[field] = true;
    return map;
  }, {});
  return getEditableFields(normalized).map((field) => ({
    field,
    label: getFieldLabel(field),
    value: fields[field] || '',
    inputType: digitFields.includes(field) ? 'digit' : (field === 'phone' ? 'number' : 'text'),
    kind: dateFields.includes(field) ? 'date' : (field === 'remark' ? 'textarea' : 'input'),
    warning: missingMap[field] ? '缺少这项' : (lowMap[field] ? '请确认这项' : '')
  }));
}

function buildWarningText(parseResult) {
  const missing = parseResult && Array.isArray(parseResult.missing_fields) ? parseResult.missing_fields : [];
  const low = parseResult && Array.isArray(parseResult.low_confidence_fields) ? parseResult.low_confidence_fields : [];
  const conflicts = parseResult && Array.isArray(parseResult.field_conflicts) ? parseResult.field_conflicts : [];
  if (conflicts.length) return '聊天里有互相覆盖或冲突的信息，请先确认最终字段。';
  if (!missing.length && !low.length) return '';
  if (missing.length) return '有信息还没补齐，可以先补字段，也可以点“待处理”。';
  return '有信息不太确定，请改一下字段后再保存。';
}

function canQuickSave(parseResult) {
  if (!parseResult || parseResult.intent === 'unknown') return false;
  return !(parseResult.missing_fields || []).length
    && !(parseResult.low_confidence_fields || []).length
    && !(parseResult.field_conflicts || []).length;
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

function buildHomeConfirmState(parseResult) {
  const normalized = normalizeEditableParseResult(parseResult);
  const quickReady = canQuickSave(normalized);
  const fieldConflictLines = formatFieldConflicts(normalized.field_conflicts || []);
  const supersededFactLines = formatSupersededFacts(normalized.superseded_facts || []);
  const remarkItemLines = formatRemarkItems(normalized.remark_items || []);
  return {
    parseResult: normalized,
    confirmFields: buildConfirmFields(normalized),
    intentLabel: INTENT_LABELS[normalized.intent] || '待确认',
    sourceLabel: INPUT_SOURCE_LABELS[normalized.source] || '输入',
    warningText: buildWarningText(normalized),
    fieldConflictLines,
    showFieldConflicts: Boolean(fieldConflictLines.length),
    supersededFactLines,
    showSupersededFacts: Boolean(supersededFactLines.length),
    remarkItemLines,
    showRemarkItems: Boolean(remarkItemLines.length),
    quickSaveText: quickReady ? '确认保存' : '补齐后保存',
    disableQuickSave: !quickReady,
    showPendingButton: Boolean((normalized.missing_fields || []).length || (normalized.low_confidence_fields || []).length || fieldConflictLines.length)
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
    showPendingButton: false
  },

  onShow() {
    refreshTabBarSelected(this);
    requestOrderFilterReset();
    this.load();
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
          composerText: '',
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
            composerText: '',
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
    this.setData({ composerText: event.detail.value });
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

  runQuickParse(text, source, pasteAnalysis) {
    const state = getState();
    const payload = {
      text,
      source,
      context: 'home',
      state
    };
    if (source === 'paste' && pasteAnalysis) {
      payload.rawText = pasteAnalysis.rawText;
      payload.extractedText = pasteAnalysis.extractedText || text;
      payload.pasteMeta = getPasteMeta(pasteAnalysis);
    }
    this.setData({
      parsing: true,
      voiceTip: source === 'voice' ? this.data.voiceTip : ''
    });
    parseHybridInput(payload)
      .then((parseResult) => {
        const confirmState = buildHomeConfirmState(parseResult);
        this.setData(Object.assign({}, confirmState, {
          parsing: false,
          voiceOverlayVisible: false,
          voiceTip: ''
        }));
      })
      .catch(() => {
        this.setData({
          parsing: false,
          voiceOverlayVisible: false
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
    const nextResult = Object.assign({}, this.data.parseResult, {
      fields: nextFields,
      missing_fields: uniqueFields(this.data.parseResult.missing_fields || []).filter((item) => item !== field),
      low_confidence_fields: uniqueFields(this.data.parseResult.low_confidence_fields || []).filter((item) => item !== field)
    });
    this.setData(buildHomeConfirmState(nextResult));
  },

  changeConfirmDate(event) {
    if (!this.data.parseResult) return;
    const field = event.currentTarget.dataset.field || 'dueDate';
    const nextFields = Object.assign({}, this.data.parseResult.fields, {
      [field]: event.detail.value
    });
    const nextResult = Object.assign({}, this.data.parseResult, {
      fields: nextFields,
      missing_fields: uniqueFields(this.data.parseResult.missing_fields || []).filter((item) => item !== field),
      low_confidence_fields: uniqueFields(this.data.parseResult.low_confidence_fields || []).filter((item) => item !== field)
    });
    this.setData(buildHomeConfirmState(nextResult));
  },

  confirmQuickSave() {
    if (!this.data.parseResult) return;
    const confirmState = buildHomeConfirmState(this.data.parseResult);
    if (confirmState.disableQuickSave) {
      this.setData(confirmState);
      wx.showToast({ title: confirmState.showFieldConflicts ? '先确认聊天里的冲突信息' : '先补齐卡片里的信息', icon: 'none' });
      return;
    }
    const state = getState();
    const saved = saveConfirmedDraft(state, confirmState.parseResult);
    saveState(state);
    wx.showToast({
      title: saved.type === 'pending' ? '已存待整理' : '已保存',
      icon: 'success'
    });
    this.setData({
      composerText: '',
      parseResult: null,
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
      showPendingButton: false
    });
    this.load();
  },

  savePendingFromConfirm() {
    if (!this.data.parseResult) return;
    const confirmState = buildHomeConfirmState(this.data.parseResult);
    const state = getState();
    savePendingNote(state, confirmState.parseResult, '用户选择稍后整理');
    saveState(state);
    wx.showToast({ title: '已存到待整理', icon: 'success' });
    this.setData({
      composerText: '',
      parseResult: null,
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
      showPendingButton: false
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

  openRecent() {
    wx.switchTab({ url: '/pages/records/records' });
  }
});
