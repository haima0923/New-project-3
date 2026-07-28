const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { safeClone, stableHash } = require('../../../utils/record-state-diff');
const { CORPUS_ROOT, ROOT } = require('./constants');
const { createFixtureResolver } = require('./resolve-fixtures');

let validatorConfirmed = false;

function ensureCorpusValidatorPasses() {
  if (validatorConfirmed) return;
  const validatorPath = path.join(ROOT, 'scripts/validate-record-e2e-corpus.js');
  const result = spawnSync(process.execPath, [validatorPath], {
    cwd: ROOT,
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      AI_API_KEY: '',
      AI_BASE_URL: '',
      API_BASE_URL: '',
      HUOXIAOLING_API_BASE_URL: ''
    })
  });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim().slice(-4000);
    throw Object.assign(new Error(`Corpus Schema/semantic validator failed: ${detail}`), {
      code: 'TEST_DATA_ERROR'
    });
  }
  validatorConfirmed = true;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    error.code = 'TEST_DATA_ERROR';
    error.message = `${path.relative(CORPUS_ROOT, filePath)}: ${error.message}`;
    throw error;
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error(`${label} must be an object`), { code: 'TEST_DATA_ERROR' });
  }
}

function validateCaseEnvelope(testCase, laneSet) {
  requireObject(testCase, 'case');
  [
    'schemaVersion', 'caseId', 'status', 'riskLevel', 'category', 'executionProfiles',
    'execution', 'input', 'clock', 'initialState', 'ai', 'interaction', 'expected'
  ].forEach((key) => {
    if (testCase[key] === undefined) {
      throw Object.assign(new Error(`${testCase.caseId || '(unknown)'} missing ${key}`), {
        code: 'TEST_DATA_ERROR'
      });
    }
  });
  if (testCase.schemaVersion !== 'record-e2e-case-v1.1') {
    throw Object.assign(new Error(`${testCase.caseId} schemaVersion is not V1.1`), {
      code: 'TEST_DATA_ERROR'
    });
  }
  if (!Array.isArray(testCase.execution.lanes) || !testCase.execution.lanes.length) {
    throw Object.assign(new Error(`${testCase.caseId} has no execution lanes`), {
      code: 'TEST_DATA_ERROR'
    });
  }
  testCase.execution.lanes.forEach((lane) => {
    if (!laneSet.has(lane)) {
      throw Object.assign(new Error(`${testCase.caseId} has unknown lane ${lane}`), {
        code: 'TEST_DATA_ERROR'
      });
    }
  });
  if (!testCase.clock.businessDate || !testCase.clock.timezone || !testCase.clock.nowInstant) {
    throw Object.assign(new Error(`${testCase.caseId} has incomplete fixed clock`), {
      code: 'TEST_DATA_ERROR'
    });
  }
}

function loadCorpus() {
  ensureCorpusValidatorPasses();
  const index = readJson(path.join(CORPUS_ROOT, 'corpus-index-v1.json'));
  const schema = readJson(path.join(CORPUS_ROOT, 'schema/record-e2e-case-v1.schema.json'));
  const enums = readJson(path.join(CORPUS_ROOT, 'contracts/record-e2e-enums-v1.json'));
  const stateFixtures = readJson(path.join(CORPUS_ROOT, index.stateFixtureFile));
  const aiFixtures = readJson(path.join(CORPUS_ROOT, index.aiFixtureFile));
  if (schema.$id !== 'record-e2e-case-v1.1.schema.json'
    || enums.caseSchemaVersion !== 'record-e2e-case-v1.1') {
    throw Object.assign(new Error('Corpus schema/enums version mismatch'), {
      code: 'TEST_DATA_ERROR'
    });
  }
  const laneSet = new Set(enums.executionLanes || []);
  const allCases = [];
  (index.caseFiles || []).forEach((relativePath) => {
    const document = readJson(path.join(CORPUS_ROOT, relativePath));
    if (!document || !Array.isArray(document.cases)) {
      throw Object.assign(new Error(`${relativePath} has no cases array`), {
        code: 'TEST_DATA_ERROR'
      });
    }
    document.cases.forEach((testCase) => {
      validateCaseEnvelope(testCase, laneSet);
      allCases.push(safeClone(testCase));
    });
  });
  const ids = allCases.map((item) => item.caseId);
  if (new Set(ids).size !== ids.length) {
    throw Object.assign(new Error('Corpus has duplicate caseId'), { code: 'TEST_DATA_ERROR' });
  }
  const activeCases = allCases.filter((item) => item.status === 'ACTIVE');
  if (activeCases.length !== index.activeCaseCount || activeCases.length !== 120) {
    throw Object.assign(new Error(`Expected 120 ACTIVE cases, got ${activeCases.length}`), {
      code: 'TEST_DATA_ERROR'
    });
  }
  const invalidStatuses = allCases.filter((item) => (
    !['ACTIVE', 'NEEDS_PRODUCT_DECISION', 'RETIRED'].includes(item.status)
  ));
  if (invalidStatuses.length) {
    throw Object.assign(new Error('Corpus contains invalid status'), { code: 'TEST_DATA_ERROR' });
  }
  const fixtureResolver = createFixtureResolver(stateFixtures, aiFixtures);
  activeCases.forEach((testCase) => {
    fixtureResolver.resolveInitialState(testCase.initialState);
    fixtureResolver.resolveAiFixture(testCase.ai);
    if (!testCase.expected || !testCase.expected.productionObservation
      || !testCase.expected.isolatedExecution) {
      throw Object.assign(new Error(`${testCase.caseId} has incomplete expected layers`), {
        code: 'TEST_DATA_ERROR'
      });
    }
  });
  return {
    activeCases,
    allCases,
    byId: new Map(activeCases.map((item) => [item.caseId, item])),
    corpusFingerprint: stableHash(activeCases, 'record-e2e-corpus-v1.1'),
    enums,
    fixtureResolver,
    index,
    schema
  };
}

module.exports = {
  ensureCorpusValidatorPasses,
  loadCorpus
};
