const { safeClone, stableHash } = require('../../../utils/record-state-diff');

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mergeFixture(base, patch) {
  if (!isObject(patch)) return safeClone(patch);
  const result = isObject(base) ? safeClone(base) : {};
  Object.keys(patch).forEach((key) => {
    const value = patch[key];
    result[key] = isObject(value) && isObject(result[key])
      ? mergeFixture(result[key], value)
      : safeClone(value);
  });
  return result;
}

function buildFixtureMap(document, kind) {
  if (!document || !Array.isArray(document.fixtures)) {
    throw Object.assign(new Error(`${kind} fixture document is invalid`), {
      code: 'TEST_DATA_ERROR'
    });
  }
  const map = new Map();
  document.fixtures.forEach((fixture) => {
    if (!fixture || !fixture.fixtureId || map.has(fixture.fixtureId)) {
      throw Object.assign(new Error(`${kind} fixtureId is missing or duplicated`), {
        code: 'TEST_DATA_ERROR'
      });
    }
    map.set(fixture.fixtureId, safeClone(fixture));
  });
  return map;
}

function createFixtureResolver(stateDocument, aiDocument) {
  const stateMap = buildFixtureMap(stateDocument, 'state');
  const aiMap = buildFixtureMap(aiDocument, 'AI');
  const stateCache = new Map();

  function resolveStateFixture(fixtureId, stack = []) {
    if (stateCache.has(fixtureId)) return safeClone(stateCache.get(fixtureId));
    const fixture = stateMap.get(fixtureId);
    if (!fixture) {
      throw Object.assign(new Error(`Unknown state fixture: ${fixtureId}`), {
        code: 'TEST_DATA_ERROR'
      });
    }
    if (stack.includes(fixtureId)) {
      throw Object.assign(new Error(`State fixture cycle: ${stack.concat(fixtureId).join(' -> ')}`), {
        code: 'TEST_DATA_ERROR'
      });
    }
    const base = fixture.extends
      ? resolveStateFixture(fixture.extends, stack.concat(fixtureId))
      : {};
    const resolved = fixture.state
      ? mergeFixture(base, fixture.state)
      : mergeFixture(base, fixture.patch || {});
    stateCache.set(fixtureId, safeClone(resolved));
    return safeClone(resolved);
  }

  function resolveInitialState(initialState) {
    if (!initialState || !initialState.fixtureRef) {
      throw Object.assign(new Error('initialState.fixtureRef is required'), {
        code: 'TEST_DATA_ERROR'
      });
    }
    const resolved = mergeFixture(
      resolveStateFixture(initialState.fixtureRef),
      initialState.overrides || {}
    );
    return {
      fixtureRef: initialState.fixtureRef,
      state: resolved,
      fingerprint: stableHash(resolved, 'e2e-initial-state-v1')
    };
  }

  function resolveAiFixture(ai) {
    if (!ai || !ai.profile) {
      throw Object.assign(new Error('ai.profile is required'), { code: 'TEST_DATA_ERROR' });
    }
    if (ai.profile === 'LOCAL_ONLY') {
      if (ai.fixtureRef) {
        throw Object.assign(new Error('LOCAL_ONLY must not reference an AI fixture'), {
          code: 'TEST_DATA_ERROR'
        });
      }
      return null;
    }
    const fixture = aiMap.get(ai.fixtureRef);
    if (!fixture) {
      throw Object.assign(new Error(`Unknown AI fixture: ${ai.fixtureRef || '(missing)'}`), {
        code: 'TEST_DATA_ERROR'
      });
    }
    return safeClone(fixture);
  }

  return {
    aiFixtureCount: aiMap.size,
    resolveAiFixture,
    resolveInitialState,
    stateFixtureCount: stateMap.size
  };
}

module.exports = {
  createFixtureResolver,
  mergeFixture
};
