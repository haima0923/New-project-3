const { parseInput } = require('../../utils/parser');
const { answerQuery } = require('../../utils/query');
const { getDashboard } = require('../../utils/business');

function normalizeState(state) {
  const source = state || {};
  return {
    customers: source.customers || [],
    quotations: source.quotations || [],
    orders: source.orders || [],
    receivables: source.receivables || [],
    paymentRecords: source.paymentRecords || [],
    dunningRecords: source.dunningRecords || [],
    todos: source.todos || [],
    orderProgress: source.orderProgress || [],
    pendingNotes: source.pendingNotes || []
  };
}

function normalizeParseResult(result) {
  const next = Object.assign({}, result);
  next.provider = 'mock';
  next.ai_fallback = {
    needed: true,
    status: 'mock'
  };
  next.field_sources = Object.assign({}, result.field_sources || {});
  Object.keys(next.field_sources).forEach((key) => {
    if (next.field_sources[key]) next.field_sources[key] = next.field_sources[key].replace(/^rule:/, 'mock:');
  });
  return next;
}

function mockParse(payload) {
  const businessContext = payload.businessContext || {};
  const state = {
    customers: payload.customerCandidates || businessContext.recentCustomers || [],
    quotations: businessContext.recentQuotations || [],
    orders: businessContext.recentOrders || [],
    receivables: businessContext.recentReceivables || [],
    paymentRecords: businessContext.recentPaymentRecords || [],
    todos: []
  };
  return normalizeParseResult(parseInput({
    text: payload.text || '',
    source: payload.source || 'typed',
    context: payload.context || 'home',
    state,
    rawText: payload.rawText || '',
    extractedText: payload.extractedText || '',
    pasteMeta: payload.pasteMeta || null
  }));
}

function mockDashboardAnswer(question, state) {
  const text = String(question || '');
  if (!/今天|今日|什么事|有啥事|要干啥/.test(text)) return null;
  const dashboard = getDashboard(normalizeState(state));
  const lines = [];
  lines.push(`${dashboard.dueToday.length + dashboard.overdue.length} 笔款要处理`);
  lines.push(`${dashboard.deliverySoon.length} 批货快到交期`);
  lines.push(`${dashboard.quoteFollowups.length} 个报价待跟进`);
  lines.push(`${(dashboard.todoActive || []).length} 个待办提醒`);
  lines.push(`${dashboard.pendingNotes.length} 条记录待整理`);
  return {
    title: `今天有 ${dashboard.totalThings} 件事`,
    lines,
    readonly: true,
    provider: 'mock'
  };
}

function mockQuery(payload) {
  const state = normalizeState(payload.state);
  const dashboardAnswer = mockDashboardAnswer(payload.question, state);
  if (dashboardAnswer) return dashboardAnswer;
  return Object.assign({}, answerQuery(payload.question || '', state), {
    readonly: true,
    provider: 'mock'
  });
}

function mockTranscribe() {
  return {
    text: '',
    confidence: 0,
    provider: 'mock',
    status: 'not_configured',
    message: '录音已保存，当前未配置语音转文字，请补充文字。'
  };
}

module.exports = {
  mockParse,
  mockQuery,
  mockTranscribe
};
