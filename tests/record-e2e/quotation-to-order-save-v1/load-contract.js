const fs = require('fs');
const path = require('path');
const { safeClone } = require('../../../utils/record-state-diff');

const ROOT = __dirname;

function readJson(fileName) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, fileName), 'utf8'));
}

function contractError(message) {
  return Object.assign(new Error(message), { code: 'TEST_DATA_ERROR' });
}

function resolveFixture(fixtureId, fixtureMap, stack = []) {
  if (stack.includes(fixtureId)) throw contractError(`Fixture extends cycle: ${stack.concat(fixtureId).join(' -> ')}`);
  const fixture = fixtureMap.get(fixtureId);
  if (!fixture) throw contractError(`Unknown quotation-to-order fixture: ${fixtureId}`);
  const base = fixture.extends
    ? resolveFixture(fixture.extends, fixtureMap, stack.concat(fixtureId))
    : safeClone(fixture.state || {});
  return Object.assign(base, safeClone(fixture.patch || {}));
}

function assertContractMetadata(testCase) {
  const required = [
    'initialPersistentState', 'userAction', 'expectedPageResult',
    'expectedSaveCalls', 'finalPersistentState', 'mustNotExist', 'productionGap'
  ];
  required.forEach((field) => {
    if (!Object.prototype.hasOwnProperty.call(testCase.contract || {}, field)) {
      throw contractError(`${testCase.caseId} contract missing ${field}`);
    }
  });
  if (!Array.isArray(testCase.contract.mustNotExist)) {
    throw contractError(`${testCase.caseId} mustNotExist must be an array`);
  }
}

function loadContract() {
  const manifest = readJson('manifest.json');
  const caseFile = readJson(manifest.caseFile);
  const fixtureFile = readJson(manifest.fixtureFile);
  if (manifest.schemaVersion !== 'quotation-to-order-save-manifest-v1') {
    throw contractError('Unsupported quotation-to-order manifest schema');
  }
  if (caseFile.schemaVersion !== 'quotation-to-order-save-cases-v1') {
    throw contractError('Unsupported quotation-to-order case schema');
  }
  if (fixtureFile.schemaVersion !== 'quotation-to-order-save-fixtures-v1') {
    throw contractError('Unsupported quotation-to-order fixture schema');
  }
  const cases = caseFile.cases || [];
  const caseIds = cases.map((item) => item.caseId);
  if (cases.length !== manifest.exactActiveCaseCount || new Set(caseIds).size !== caseIds.length) {
    throw contractError(`Expected ${manifest.exactActiveCaseCount} unique quotation-to-order cases`);
  }
  if (JSON.stringify(caseIds) !== JSON.stringify(manifest.caseIds)) {
    throw contractError('Manifest case order does not exactly match cases.json');
  }
  const fixtureMap = new Map((fixtureFile.fixtures || []).map((item) => [item.fixtureId, item]));
  if (fixtureMap.size !== (fixtureFile.fixtures || []).length) {
    throw contractError('Duplicate quotation-to-order fixture ID');
  }
  const resolvedCases = cases.map((testCase) => {
    assertContractMetadata(testCase);
    return Object.assign({}, safeClone(testCase), {
      clock: {
        businessDate: '2026-07-15',
        nowInstant: '2026-07-15T02:00:00.000Z',
        timezone: 'Asia/Shanghai'
      },
      initialState: { state: resolveFixture(testCase.fixtureRef, fixtureMap) }
    });
  });
  return { cases: resolvedCases, manifest: safeClone(manifest) };
}

function createRuntimeSpec(testCase) {
  return {
    ai: { profile: 'LOCAL_ONLY' },
    aiFixture: null,
    caseId: testCase.caseId,
    category: 'QUOTATION_TO_ORDER_SAVE',
    clock: safeClone(testCase.clock),
    initialState: safeClone(testCase.initialState),
    input: {
      channel: 'QUOTATION_LIST_CLICK',
      clipboardText: '',
      entrySurface: 'QUOTATION_LIST',
      originalText: '',
      voiceTranscript: ''
    },
    riskLevel: testCase.riskLevel
  };
}

module.exports = {
  createRuntimeSpec,
  loadContract,
  resolveFixture
};
