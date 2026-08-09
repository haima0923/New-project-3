const fs = require('fs');
const Module = require('module');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../..');
const SERVER_PATH = path.join(ROOT, 'server/src/server.js');

let decideServerParseRoute;

function loadDecisionFunction() {
  if (decideServerParseRoute) return decideServerParseRoute;
  const source = fs.readFileSync(SERVER_PATH, 'utf8');
  const bootMarker = 'const server = http.createServer(handleRequest);';
  const bootIndex = source.indexOf(bootMarker);
  if (bootIndex < 0) {
    const error = new Error('Trusted server route boot marker is missing');
    error.code = 'TEST_DATA_ERROR';
    throw error;
  }
  const testModule = new Module(`${SERVER_PATH}?conversation-route-probe`, module);
  testModule.filename = SERVER_PATH;
  testModule.paths = Module._nodeModulePaths(path.dirname(SERVER_PATH));
  testModule._compile(`${source.slice(0, bootIndex)}\nmodule.exports = { decideServerParseRoute };\n`, SERVER_PATH);
  decideServerParseRoute = testModule.exports.decideServerParseRoute;
  if (typeof decideServerParseRoute !== 'function') {
    const error = new Error('Trusted server route decision function is unavailable');
    error.code = 'TEST_DATA_ERROR';
    throw error;
  }
  return decideServerParseRoute;
}

function probeServerRoute(requestData) {
  const decision = loadDecisionFunction()(requestData || {});
  return {
    questionTarget: decision.questionTarget || null,
    reasonCodes: Array.isArray(decision.reasonCodes) ? decision.reasonCodes.slice() : [],
    route: String(decision.route || ''),
    text: String(decision.text || '')
  };
}

module.exports = { probeServerRoute };
