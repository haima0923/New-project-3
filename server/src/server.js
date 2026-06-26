const http = require('http');
const { getConfig, isRealAiEnabled } = require('./config');
const { getAllowedOrigin, readJsonBody, sendJson } = require('./lib/http');
const { parseWithAi, queryWithAi } = require('./ai/model');

const config = getConfig();

function handleRequest(req, res) {
  const origin = getAllowedOrigin(req, config.allowedOrigins);

  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {}, origin);
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, {
      ok: true,
      service: 'yiwu-boss-ai-assistant-server',
      mode: isRealAiEnabled(config) ? 'ai' : 'mock'
    }, origin);
    return;
  }

  if (req.method === 'POST' && req.url === '/api/ai/parse') {
    readJsonBody(req)
      .then((body) => parseWithAi(config, body))
      .then((payload) => sendJson(res, 200, payload, origin))
      .catch((error) => sendJson(res, 500, {
        error: 'AI_PARSE_FAILED',
        message: error.message
      }, origin));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/ai/query') {
    readJsonBody(req)
      .then((body) => queryWithAi(config, body))
      .then((payload) => sendJson(res, 200, payload, origin))
      .catch((error) => sendJson(res, 500, {
        error: 'AI_QUERY_FAILED',
        message: error.message
      }, origin));
    return;
  }

  sendJson(res, 404, {
    error: 'NOT_FOUND'
  }, origin);
}

const server = http.createServer(handleRequest);
server.listen(config.port, () => {
  console.log(`AI assistant server listening on ${config.port}`);
  console.log(`Mode: ${isRealAiEnabled(config) ? 'AI' : 'mock'}`);
});
