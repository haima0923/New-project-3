const { safeClone, stableHash } = require('../../../utils/record-state-diff');
const { BUSINESS_STORAGE_KEY } = require('./constants');
const { createFakeNetwork } = require('./create-fake-network');
const { createFakeVoice } = require('./create-fake-voice');
const { assertFakeWxApi, createFakeWx } = require('./create-fake-wx');

function seedFrom(value) {
  const text = String(value || '');
  let seed = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    seed ^= text.charCodeAt(index);
    seed = Math.imul(seed, 16777619) >>> 0;
  }
  return seed || 1;
}

function createDeterministicRandom(seedText) {
  let state = seedFrom(seedText);
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function installFrozenClock(nowInstant, seedText) {
  const NativeDate = global.Date;
  const NativeRandom = Math.random;
  const fixedMs = new NativeDate(nowInstant).getTime();
  if (!Number.isFinite(fixedMs)) {
    throw Object.assign(new Error(`Invalid nowInstant: ${nowInstant}`), {
      code: 'TEST_DATA_ERROR'
    });
  }
  class FrozenDate extends NativeDate {
    constructor(...args) {
      super(...(args.length ? args : [fixedMs]));
    }
    static now() { return fixedMs; }
  }
  global.Date = FrozenDate;
  Math.random = createDeterministicRandom(seedText);
  return () => {
    global.Date = NativeDate;
    Math.random = NativeRandom;
  };
}

function createCaseRuntime(spec, options = {}) {
  const previousTimezone = process.env.TZ;
  process.env.TZ = spec.clock.timezone;
  const network = createFakeNetwork({
    aiFixture: spec.aiFixture,
    aiProfile: spec.ai.profile
  });
  network.guardHostNetwork();
  const initialEntries = safeClone(options.initialEntries || {
    [BUSINESS_STORAGE_KEY]: spec.initialState.state,
    huoxiaoling_ai_auth_session_v1: {
      token: 'REDACTED_SYNTHETIC_TEST_TOKEN',
      expiresAt: '2027-07-15T02:00:00.000Z'
    }
  });
  const clipboardText = spec.input.clipboardText || spec.input.originalText;
  const voiceText = spec.input.voiceTranscript || spec.input.originalText;
  const voice = createFakeVoice(voiceText);
  const fakeWx = createFakeWx({ clipboardText, initialEntries, network });
  assertFakeWxApi(fakeWx.wx);
  const app = {
    globalData: {
      userId: 'e2e-user',
      apiBaseUrl: 'memory://record-e2e',
      aiAuthEnabled: true,
      aiParseEndpoint: '/api/ai/parse',
      aiTranscribeEndpoint: '',
      recordStorageRecoveryLocked: false,
      recordStorageStartupStatus: ''
    }
  };
  global.wx = fakeWx.wx;
  global.getApp = () => app;
  global.requirePlugin = (name) => (name === 'WechatSI' ? voice.plugin : null);
  const restoreClock = installFrozenClock(
    spec.clock.nowInstant,
    spec.caseId
  );
  return {
    app,
    audit() {
      return {
        networkAudit: network.audit(),
        storageAudit: fakeWx.audit(),
        voiceAudit: voice.audit()
      };
    },
    bootId: `${spec.caseId}:boot:${process.pid}:${options.attempt || 1}`,
    dispose() {
      restoreClock();
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
      delete global.wx;
      delete global.getApp;
      delete global.requirePlugin;
      delete global.Page;
      delete global.App;
    },
    fakeWx,
    initialStateFingerprint: stableHash(spec.initialState.state, 'e2e-initial-state-v1'),
    network,
    voice
  };
}

module.exports = {
  createCaseRuntime,
  createDeterministicRandom,
  installFrozenClock
};
