const { getApiBaseUrl, requestJson } = require('./api-client');
const { answerQuery } = require('./query');

const AI_QUERY_TIMEOUT_MS = 30000;

function unwrapAnswer(answer) {
  if (!answer || typeof answer !== 'object') return {};
  if (answer.data && typeof answer.data === 'object') return unwrapAnswer(answer.data);
  if (answer.result && typeof answer.result === 'object') return unwrapAnswer(answer.result);
  return answer;
}

function normalizeLines(answer) {
  if (Array.isArray(answer.lines)) {
    return answer.lines
      .map((item) => String(item || '').trim())
      .filter(Boolean);
  }
  if (Array.isArray(answer.items)) {
    return answer.items
      .map((item) => {
        if (typeof item === 'string') return item;
        if (!item || typeof item !== 'object') return '';
        return item.text || item.content || item.summary || '';
      })
      .map((item) => String(item || '').trim())
      .filter(Boolean);
  }
  const singleLine = answer.answer || answer.content || answer.message || '';
  return singleLine ? [String(singleLine).trim()] : [];
}

function normalizeAiAnswer(localAnswer, rawAnswer) {
  const answer = unwrapAnswer(rawAnswer);
  const lines = normalizeLines(answer);
  if (!answer.title && !lines.length) {
    return Object.assign({}, localAnswer, {
      provider: 'local',
      aiStatus: 'failed'
    });
  }
  return {
    title: answer.title || '查询结果',
    lines,
    readonly: true,
    provider: answer.provider || 'server',
    aiStatus: answer.provider === 'mock' ? 'mock_used' : 'used'
  };
}

function askHybridQuery(question, state) {
  const localAnswer = answerQuery(question, state);
  if (typeof wx === 'undefined' || !getApiBaseUrl()) {
    return Promise.resolve(Object.assign({}, localAnswer, {
      provider: 'local',
      aiStatus: 'skipped_no_endpoint'
    }));
  }

  return requestJson('/api/ai/query', {
    question,
    state
  }, AI_QUERY_TIMEOUT_MS)
    .then((answer) => normalizeAiAnswer(localAnswer, answer))
    .catch(() => Object.assign({}, localAnswer, {
      provider: 'local',
      aiStatus: 'failed'
    }));
}

module.exports = {
  askHybridQuery,
  normalizeAiAnswer
};
