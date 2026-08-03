const fs = require('fs');
const path = require('path');
const { safeClone } = require('../../../utils/record-state-diff');

const ROOT = __dirname;

function contractError(message) {
  return Object.assign(new Error(message), { code: 'TEST_DATA_ERROR' });
}

function readJson(fileName) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, fileName), 'utf8'));
}

function resolveFixture(fixtureId, fixtureMap, stack = []) {
  if (stack.includes(fixtureId)) throw contractError(`Fixture extends cycle: ${stack.concat(fixtureId).join(' -> ')}`);
  const fixture = fixtureMap.get(fixtureId);
  if (!fixture) throw contractError(`Unknown single-item-order fixture: ${fixtureId}`);
  const base = fixture.extends
    ? resolveFixture(fixture.extends, fixtureMap, stack.concat(fixtureId))
    : safeClone(fixture.state || {});
  return Object.assign(base, safeClone(fixture.patch || {}));
}

function assertContractMetadata(testCase) {
  const required = [
    'initialPersistentState', 'input', 'pageEntry', 'expectedParseRoute',
    'expectedAiCalls', 'expectedConfirmationFields', 'expectedPageFormalSaveCalls',
    'expectedSaveStateCalls', 'expectedCommitResult', 'expectedPersistentState',
    'expectedListAndDetail', 'expectedRestart', 'mustNotExist', 'productionGap'
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
  const fixtureFile = readJson(manifest.fixtureFile);
  const caseModule = require(path.join(ROOT, manifest.caseModule));
  if (manifest.schemaVersion !== 'single-item-order-complete-save-manifest-v1') {
    throw contractError('Unsupported single-item-order manifest schema');
  }
  if (fixtureFile.schemaVersion !== 'single-item-order-complete-save-fixtures-v1') {
    throw contractError('Unsupported single-item-order fixture schema');
  }
  const cases = caseModule.cases || [];
  const ids = cases.map((item) => item.caseId);
  if (cases.length !== manifest.exactActiveCaseCount || new Set(ids).size !== ids.length) {
    throw contractError(`Expected ${manifest.exactActiveCaseCount} unique single-item-order cases`);
  }
  const fixtureMap = new Map((fixtureFile.fixtures || []).map((item) => [item.fixtureId, item]));
  if (fixtureMap.size !== (fixtureFile.fixtures || []).length) throw contractError('Duplicate fixture ID');
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
    category: 'SINGLE_ITEM_ORDER_COMPLETE_SAVE',
    clock: safeClone(testCase.clock),
    initialState: safeClone(testCase.initialState),
    input: {
      channel: 'MANUAL_TEXT',
      clipboardText: '',
      entrySurface: testCase.entrySurface,
      originalText: testCase.sample.input,
      voiceTranscript: ''
    },
    riskLevel: testCase.riskLevel
  };
}

module.exports = { createRuntimeSpec, loadContract, resolveFixture };
