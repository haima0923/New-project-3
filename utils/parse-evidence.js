const { INPUT_SOURCE_LABELS, INTENT_LABELS } = require('./constants');

function getItems(fields = {}) {
  if (Array.isArray(fields.items) && fields.items.length) {
    return fields.items.filter((item) => item && (item.productName || item.quantity || item.unitPrice));
  }
  if (fields.productName || fields.quantity || fields.unitPrice) {
    return [{
      productName: fields.productName || '',
      quantity: fields.quantity || '',
      unitPrice: fields.unitPrice || ''
    }];
  }
  return [];
}

function getAiEvidence(aiFallback = {}) {
  const status = aiFallback.status || 'not_requested';
  const fallbackReason = String(aiFallback.reason || '').trim();
  const code = String(aiFallback.code || '').trim();
  const details = {
    used: {
      statusText: 'AI 已成功返回结果',
      detail: fallbackReason || '这张确认卡已参考 AI 的整理结果。',
      tone: 'success'
    },
    mock_used: {
      statusText: '没有使用真实 AI',
      detail: fallbackReason || '当前服务返回的是模拟结果，不能当作真实 AI 测试通过。',
      tone: 'warning'
    },
    failed: {
      statusText: '智能快速核对未完成',
      detail: fallbackReason || '当前没有可靠的智能核对结果，这条只能先待整理。',
      tone: 'warning'
    },
    timed_out: {
      statusText: '智能核对等待超时',
      detail: fallbackReason || 'AI 没有在等待上限内返回可靠结果，这条只能先待整理。',
      tone: 'warning'
    },
    returned_uncertain: {
      statusText: 'AI 已返回，但不够确定',
      detail: fallbackReason || 'AI 没有把关键内容说清楚，当前不会把它当成可保存的结果。',
      tone: 'warning'
    },
    skipped_no_endpoint: {
      statusText: '本次没有连接 AI',
      detail: fallbackReason || '当前只按基础规则整理，请重点核对这张卡。',
      tone: 'warning'
    },
    not_requested: {
      statusText: '本次没有请求 AI',
      detail: fallbackReason || '这条内容先按基础规则整理。',
      tone: 'neutral'
    }
  };
  return Object.assign({ status, code, attempted: Boolean(aiFallback.attempted) }, details[status] || {
    statusText: 'AI 状态不清楚',
    detail: '无法确认本次是否拿到了 AI 结果，这条测试不能算通过。',
    tone: 'warning'
  });
}

function getResultSummary(parseResult = {}) {
  const fields = parseResult.fields || {};
  const pieces = [INTENT_LABELS[parseResult.intent] || '待确认'];
  const items = getItems(fields);
  if (items.length) pieces.push(`${items.length} 件商品`);
  if (fields.customerName) pieces.push(`客户：${fields.customerName}`);
  if (fields.dueDate) pieces.push(`日期：${fields.dueDate}`);
  return pieces.join(' · ');
}

function formatDuration(value) {
  if (value === undefined || value === null || value === '') return '未记录';
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '未记录';
  if (milliseconds < 1000) return '不到 1 秒';
  return `${(milliseconds / 1000).toFixed(milliseconds < 10000 ? 1 : 0)} 秒`;
}

function getDraftSummary(draft = {}) {
  const pieces = [INTENT_LABELS[draft.intent] || '待确认'];
  if (draft.customerName) pieces.push(`客户：${draft.customerName}`);
  if (draft.productName) pieces.push(`商品：${draft.productName}`);
  if (draft.quantity) pieces.push(`数量：${draft.quantity}`);
  if (draft.unitPrice) pieces.push(`单价：${draft.unitPrice}`);
  if (draft.paymentAmount) pieces.push(`本次收款：${draft.paymentAmount}`);
  if (draft.dueDate) pieces.push(`日期：${draft.dueDate}`);
  if (draft.itemCount > 1) pieces.push(`${draft.itemCount} 件商品`);
  return pieces.join(' · ');
}

function getRouteEvidence(parseResult = {}) {
  const trace = parseResult.parse_trace || {};
  const route = trace.route || parseResult.parse_route || {};
  const reasons = Array.isArray(route.reasons) ? route.reasons.filter(Boolean) : [];
  const waitLimit = Number(trace.networkWaitLimitMs);
  return {
    routeLabel: route.label || '本次处理方式未记录',
    routeReasons: reasons.map(toPlainRouteReason).filter(Boolean).join('；') || '本次没有记录为什么选择这条处理方式。',
    localSummary: getDraftSummary(trace.localDraft || {}),
    aiSummary: trace.aiDraft ? getDraftSummary(trace.aiDraft) : '',
    localDurationText: formatDuration(trace.localDurationMs),
    aiDurationText: formatDuration(trace.aiDurationMs),
    totalDurationText: formatDuration(trace.totalDurationMs),
    networkWaitLimitText: Number.isFinite(waitLimit) && waitLimit > 0 ? formatDuration(waitLimit) : '',
    aiRequestId: trace.aiRequestId || '',
    aiServerElapsedText: trace.aiServerElapsedMs ? formatDuration(trace.aiServerElapsedMs) : '',
    aiServerDeadlineText: trace.aiServerDeadlineMs ? formatDuration(trace.aiServerDeadlineMs) : '',
    aiModelTier: trace.aiModelTier || '',
    aiFailureCode: trace.aiFailureCode || ''
  };
}

function toPlainCheckReason(reason) {
  const text = String(reason || '').trim();
  const lower = text.toLowerCase();
  if (!text) return '';
  if (lower.includes('intent') || text.includes('业务类型')) {
    return '系统还没判断出这是报价、订单、收款还是提醒，请你手动选择。';
  }
  if (lower.includes('customer') || text.includes('客户')) {
    return '客户名称还不清楚，请你确认后再保存。';
  }
  if (lower.includes('product') || text.includes('商品')) {
    return '商品信息还不清楚，请你补充或确认。';
  }
  if (lower.includes('quantity') || text.includes('数量')) {
    return '数量还不清楚，请你补充或确认。';
  }
  if (lower.includes('unitprice') || lower.includes('price') || text.includes('单价') || text.includes('价格')) {
    return '价格还不清楚，请你补充或确认。';
  }
  if (lower.includes('date') || text.includes('日期') || text.includes('交期')) {
    return '日期或交期还不清楚，请你补充或确认。';
  }
  if (lower.includes('multi') || text.includes('多笔') || text.includes('多商品')) {
    return '这句话里可能不止一件事，请打开完整记一笔逐项确认。';
  }
  if (lower.includes('conflict') || text.includes('冲突') || text.includes('矛盾')) {
    return '内容前后有不一致的地方，请以实际情况为准修改。';
  }
  return '有信息不太确定，请你逐项核对后再保存。';
}

function toPlainRouteReason(reason) {
  const text = String(reason || '').trim();
  if (!text) return '';
  if (text.includes('语音转成文字')) return '这是语音转成的文字；是否请求智能核对，要看文字本身是否清楚。';
  if (text.includes('聊天内容需要结合上下文') || text.includes('多轮聊天')) return '这是一段聊天内容，需要按前后顺序核对。';
  if (text.includes('涉及收款') || text.includes('欠款') || text.includes('定金')) return '这条涉及钱款，系统会更谨慎地核对。';
  if (text.includes('多个商品')) return '这句话可能有多个商品，需要逐项确认。';
  if (text.includes('本地发现有不稳定字段')) return '本地整理发现有不确定的信息，需要再核对。';
  if (text.includes('本地没有稳定判断')) return '本地还不能稳定判断这是一笔什么业务。';
  if (text.includes('文字是一件清楚的业务')) return '这是一条信息比较完整的业务，先快速整理。';
  if (text.includes('深度核对')) return '这条内容有风险，系统先不猜；你可以主动选择深度核对。';
  if (text.includes('原文缺少关键信息')) return '原文缺少关键信息，不能替你猜。';
  if (text.includes('没有识别到一笔明确业务')) return '没有识别到一笔明确业务，先不替你猜。';
  return toPlainCheckReason(text);
}

function getCheckText(parseResult = {}, aiEvidence = {}) {
  const safety = parseResult.local_parse_safety || {};
  const reasons = Array.isArray(safety.reason_texts) ? safety.reason_texts.filter(Boolean) : [];
  const missing = Array.isArray(parseResult.missing_fields) ? parseResult.missing_fields : [];
  const low = Array.isArray(parseResult.low_confidence_fields) ? parseResult.low_confidence_fields : [];
  if (aiEvidence.status === 'failed' || aiEvidence.status === 'timed_out' || aiEvidence.status === 'skipped_no_endpoint' || aiEvidence.status === 'returned_uncertain') {
    return '智能核对没有给出可靠结果，本次不能正式保存；请补充后再试或先放待整理。';
  }
  if (reasons.length) return reasons.map(toPlainCheckReason).filter(Boolean).join('；');
  if (missing.length || low.length) return '这张卡还有需要补充或确认的内容。';
  return '没有发现需要额外提示的地方，保存前仍请核对关键字段。';
}

function buildParseEvidence(parseResult = {}) {
  const source = parseResult.source || 'typed';
  const sourceText = parseResult.extracted_text || parseResult.original_text || '';
  const ai = getAiEvidence(parseResult.ai_fallback || {});
  const route = getRouteEvidence(parseResult);
  return {
    sourceLabel: INPUT_SOURCE_LABELS[source] || '输入',
    sourceTextLabel: source === 'voice' ? '语音转成文字' : (source === 'paste' ? '用于整理的聊天内容' : '用于整理的文字'),
    sourceText,
    aiStatusText: ai.statusText,
    aiDetail: ai.detail,
    aiTone: ai.tone,
    aiAttempted: ai.attempted,
    aiFailureCode: ai.code || route.aiFailureCode || '',
    routeLabel: route.routeLabel,
    routeReasons: route.routeReasons,
    localSummary: route.localSummary,
    aiSummary: route.aiSummary,
    localDurationText: route.localDurationText,
    aiDurationText: route.aiDurationText,
    totalDurationText: route.totalDurationText,
    networkWaitLimitText: route.networkWaitLimitText,
    aiRequestId: route.aiRequestId,
    aiServerElapsedText: route.aiServerElapsedText,
    aiServerDeadlineText: route.aiServerDeadlineText,
    aiModelTier: route.aiModelTier,
    resultSummary: getResultSummary(parseResult),
    checkText: getCheckText(parseResult, ai)
  };
}

module.exports = {
  buildParseEvidence,
  getAiEvidence,
  getDraftSummary,
  getRouteEvidence,
  getResultSummary,
  toPlainRouteReason,
  toPlainCheckReason
};
