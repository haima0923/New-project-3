const { getApiBaseUrl, requestJson } = require('./api-client');
const { answerQuery } = require('./query');

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
  })
    .then((answer) => Object.assign({}, localAnswer, answer, {
      provider: answer.provider || 'server',
      aiStatus: answer.provider === 'mock' ? 'mock_used' : 'used'
    }))
    .catch(() => Object.assign({}, localAnswer, {
      provider: 'local',
      aiStatus: 'failed'
    }));
}

module.exports = {
  askHybridQuery
};
