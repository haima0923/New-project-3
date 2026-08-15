const {
  createTranscriptFingerprint
} = require('../../../utils/voice-recognition');
const { createHoldHarness, flushAsync } = require('../record-hold-to-talk-v1/runtime');

const HERO_TEXT = '王总要保温杯500个，周三交';
const TAB_TEXT = '李总要纸杯300个，周五交';
const DIRECT_TEXT = '赵姐要礼品盒200套，8月20日交';
const MISMATCH_TEXT = '这是另一次语音的文字';
const POST_ONSTART_STABILIZATION_MS = 700;

function check(code, pass, expected, actual) {
  return { actual, code, expected, pass: pass === true };
}

function inputNavigations(audit = {}) {
  return (audit.navigation || []).filter((entry) => entry.url === '/pages/input/input');
}

function finalRoute(page) {
  return page && page.data && page.data.parseResult && page.data.parseResult.parse_route || {};
}

function evidenceShape(evidence, text, sessionId) {
  return Boolean(evidence)
    && evidence.version === 'voice-completion-evidence-v1'
    && evidence.status === 'COMPLETED'
    && evidence.isFinal === true
    && evidence.source === 'VOICE_TRANSCRIPT'
    && evidence.callbackName === 'onStop'
    && evidence.sessionId === sessionId
    && evidence.transcriptLength === text.length
    && evidence.transcriptFingerprint === createTranscriptFingerprint(sessionId, text);
}

function routeHasValidEvidence(route = {}) {
  return route.voice_completion_evidence_present === true
    && route.voice_completion_evidence_valid === true
    && route.voice_completion_evidence_fingerprint_matched === true
    && route.voice_completion_evidence_session_matched === true;
}

function startHero(harness) {
  harness.dispatchHero('start', harness.touch.touchStart());
  harness.voice.emitStart();
  harness.scheduler.advanceBy(POST_ONSTART_STABILIZATION_MS);
}

function finishHero(harness, text) {
  harness.dispatchHero('end', harness.touch.touchEnd());
  harness.voice.emitFinal(undefined, text);
}

function startTab(harness) {
  harness.dispatchTab('start', harness.touch.touchStart());
  harness.voice.emitStart();
  harness.scheduler.advanceBy(POST_ONSTART_STABILIZATION_MS);
}

function finishTab(harness, text) {
  harness.dispatchTab('end', harness.touch.touchEnd());
  harness.voice.emitFinal(undefined, text);
}

async function withHarness(options, callback) {
  const harness = createHoldHarness(options);
  try {
    return await callback(harness);
  } finally {
    harness.dispose();
  }
}

async function vre001() {
  return withHarness({ caseId: 'VRE-001', text: HERO_TEXT }, async (harness) => {
    startHero(harness);
    finishHero(harness, HERO_TEXT);
    await harness.followInput();
    const audit = harness.audit();
    const payload = audit.handoff.publishPayloads[0] || {};
    const consumed = audit.handoff.consumePayloads[0] || {};
    const session = audit.voice.session || {};
    const route = finalRoute(harness.input.page);
    const parserEvidence = audit.parser.voiceInputEvidence[0] || {};
    return [
      check('VRE001.HANDOFF_EVIDENCE_PRESENT', evidenceShape(
        payload.voiceCompletionEvidence,
        HERO_TEXT,
        session.sessionId
      ), true, payload),
      check('VRE001.HERO_ORIGIN_SURFACE', payload.originSurface === 'DASHBOARD_HERO',
        'DASHBOARD_HERO', payload.originSurface),
      check('VRE001.CONSUMED_CLONE_VALID', evidenceShape(
        consumed.voiceCompletionEvidence,
        HERO_TEXT,
        session.sessionId
      ) && audit.handoff.consumeEvidenceAudit.frozen === true
        && audit.handoff.consumeEvidenceAudit.aliasesPublishInput === false,
      'valid frozen non-alias evidence', {
        consumed,
        evidenceAudit: audit.handoff.consumeEvidenceAudit
      }),
      check('VRE001.RECORD_INTAKE_VERIFIED', routeHasValidEvidence(route)
        && parserEvidence.present === true
        && parserEvidence.inputChannel === 'VOICE_TRANSCRIPT', true, { parserEvidence, route }),
      check('VRE001.EXACTLY_ONCE', audit.handoff.publishCount === 1
        && audit.handoff.consumeCount === 1
        && audit.input.runParseCount === 1
        && audit.parser.hybridCount === 1, true, audit),
      check('VRE001.ORIGINAL_TEXT_EXACT', audit.input.text === HERO_TEXT
        && audit.input.originalText === HERO_TEXT
        && audit.input.source === 'voice', HERO_TEXT, audit.input)
    ];
  });
}

async function vre002() {
  return withHarness({ caseId: 'VRE-002', origin: 'records', text: TAB_TEXT }, async (harness) => {
    startTab(harness);
    finishTab(harness, TAB_TEXT);
    await harness.followInput();
    const audit = harness.audit();
    const payload = audit.handoff.publishPayloads[0] || {};
    const session = audit.voice.session || {};
    const route = finalRoute(harness.input.page);
    return [
      check('VRE002.HANDOFF_EVIDENCE_PRESENT', evidenceShape(
        payload.voiceCompletionEvidence,
        TAB_TEXT,
        session.sessionId
      ), true, payload),
      check('VRE002.TAB_ORIGIN_SURFACE', payload.originSurface === 'CUSTOM_TAB_CENTER',
        'CUSTOM_TAB_CENTER', payload.originSurface),
      check('VRE002.RECORD_INTAKE_VERIFIED', routeHasValidEvidence(route), true, route),
      check('VRE002.EXACTLY_ONCE', audit.handoff.publishCount === 1
        && audit.handoff.consumeCount === 1
        && audit.input.runParseCount === 1
        && audit.parser.hybridCount === 1, true, audit),
      check('VRE002.ORIGINAL_TEXT_EXACT', audit.input.originalText === TAB_TEXT
        && audit.input.source === 'voice', TAB_TEXT, audit.input)
    ];
  });
}

async function vre003() {
  return withHarness({ caseId: 'VRE-003', text: HERO_TEXT }, async (harness) => {
    harness.dashboard.page.onComposerInput({ detail: { value: HERO_TEXT } });
    harness.dashboard.page.submitComposer();
    await harness.followInput();
    const audit = harness.audit();
    const payload = audit.handoff.publishPayloads[0] || {};
    const consumed = audit.handoff.consumePayloads[0] || {};
    const parserEvidence = audit.parser.voiceInputEvidence[0] || {};
    return [
      check('VRE003.TYPED_SOURCE', audit.input.source === 'typed'
        && parserEvidence.inputChannel === 'MANUAL_TEXT',
      { inputChannel: 'MANUAL_TEXT', source: 'typed' }, { input: audit.input, parserEvidence }),
      check('VRE003.NO_VOICE_PROVENANCE', !Object.prototype.hasOwnProperty.call(payload, 'voiceCompletionEvidence')
        && !Object.prototype.hasOwnProperty.call(consumed, 'voiceCompletionEvidence')
        && parserEvidence.present !== true, true, { consumed, parserEvidence, payload }),
      check('VRE003.ORIGINAL_TEXT_EXACT', audit.input.originalText === HERO_TEXT, HERO_TEXT, audit.input.originalText)
    ];
  });
}

async function vre004() {
  return withHarness({ caseId: 'VRE-004', clipboardText: HERO_TEXT }, async (harness) => {
    harness.dashboard.page.pasteClipboard();
    await flushAsync();
    await harness.followInput();
    const audit = harness.audit();
    const payload = audit.handoff.publishPayloads[0] || {};
    const consumed = audit.handoff.consumePayloads[0] || {};
    const parserEvidence = audit.parser.voiceInputEvidence[0] || {};
    return [
      check('VRE004.CLIPBOARD_SOURCE', audit.input.source === 'paste'
        && parserEvidence.inputChannel === 'PASTE_TEXT',
      { inputChannel: 'PASTE_TEXT', source: 'paste' }, { input: audit.input, parserEvidence }),
      check('VRE004.NO_VOICE_PROVENANCE', !Object.prototype.hasOwnProperty.call(payload, 'voiceCompletionEvidence')
        && !Object.prototype.hasOwnProperty.call(consumed, 'voiceCompletionEvidence')
        && parserEvidence.present !== true, true, { consumed, parserEvidence, payload }),
      check('VRE004.ORIGINAL_TEXT_EXACT', audit.input.originalText === HERO_TEXT, HERO_TEXT, audit.input.originalText)
    ];
  });
}

async function vre005() {
  return withHarness({ caseId: 'VRE-005', text: HERO_TEXT }, async (harness) => {
    const handoff = require('../../../utils/record-entry-handoff');
    handoff.publishRecordEntryHandoff({
      autoParse: true,
      originSurface: 'DASHBOARD_HERO',
      originalText: HERO_TEXT,
      source: 'voice'
    });
    harness.fakeWx.wx.switchTab({ url: '/pages/input/input' });
    await harness.followInput();
    const audit = harness.audit();
    const route = finalRoute(harness.input.page);
    const parserEvidence = audit.parser.voiceInputEvidence[0] || {};
    return [
      check('VRE005.MARKED_UNVERIFIED', parserEvidence.present !== true
        && route.voice_completion_evidence_present !== true
        && route.voice_completion_evidence_valid !== true
        && route.voice_completion_evidence_session_matched !== true,
      'unverified voice intake', { parserEvidence, route }),
      check('VRE005.NOT_VOICE_STANDARD', route.voice_standard_eligible !== true
        && (route.voice_standard_exclusion_codes || []).includes('VOICE_COMPLETION_EVIDENCE_MISSING'),
      'VOICE_COMPLETION_EVIDENCE_MISSING', route.voice_standard_exclusion_codes || []),
      check('VRE005.NO_VERIFIED_REASON', !(route.voice_standard_reason_codes || [])
        .includes('VOICE_FINAL_TRANSCRIPT_VERIFIED'), false, route.voice_standard_reason_codes || []),
      check('VRE005.NO_AUTO_SAVE', Object.values(audit.input.writerCalls).every((count) => count === 0)
        && audit.businessMutation === false, true, audit)
    ];
  });
}

async function vre006() {
  return withHarness({ caseId: 'VRE-006', text: HERO_TEXT }, async (harness) => {
    startHero(harness);
    finishHero(harness, HERO_TEXT);
    const handoff = require('../../../utils/record-entry-handoff');
    handoff.consumeRecordEntryHandoff();
    const evidence = harness.audit().voice.session.evidence;
    handoff.publishRecordEntryHandoff({
      autoParse: true,
      originSurface: 'DASHBOARD_HERO',
      originalText: MISMATCH_TEXT,
      source: 'voice',
      voiceCompletionEvidence: evidence
    });
    harness.fakeWx.wx.switchTab({ url: '/pages/input/input' });
    await harness.followInput();
    const audit = harness.audit();
    const consumed = audit.handoff.consumePayloads.slice(-1)[0] || {};
    const validation = require('../../../utils/voice-recognition')
      .validateVoiceCompletionEvidence(evidence, MISMATCH_TEXT, {
      inputChannel: 'VOICE_TRANSCRIPT'
      });
    const route = finalRoute(harness.input.page);
    const parserEvidence = audit.parser.voiceInputEvidence[0] || {};
    return [
      check('VRE006.MISMATCH_EVIDENCE_PRESERVED', evidenceShape(
        consumed.voiceCompletionEvidence,
        HERO_TEXT,
        evidence.sessionId
      ), true, consumed),
      check('VRE006.MISMATCH_REJECTED', validation.valid === false
        && validation.reasons.includes('VOICE_TRANSCRIPT_CHANGED')
        && validation.reasons.includes('VOICE_TRANSCRIPT_FINGERPRINT_MISMATCH'),
      ['VOICE_TRANSCRIPT_CHANGED', 'VOICE_TRANSCRIPT_FINGERPRINT_MISMATCH'], validation),
      check('VRE006.RECORD_MARKED_UNVERIFIED', parserEvidence.present === true
        && parserEvidence.fingerprintMatched === false
        && route.voice_completion_evidence_valid !== true
        && route.voice_completion_evidence_fingerprint_matched !== true
        && route.voice_standard_eligible !== true,
      'unverified voice intake', { parserEvidence, route }),
      check('VRE006.NO_AUTO_SAVE', Object.values(audit.input.writerCalls).every((count) => count === 0)
        && audit.businessMutation === false, true, audit),
      check('VRE006.TEXT_RETAINED_FOR_CORRECTION', audit.input.text === MISMATCH_TEXT
        && audit.input.source === 'voice', MISMATCH_TEXT, audit.input)
    ];
  });
}

async function vre007() {
  return withHarness({ caseId: 'VRE-007', text: HERO_TEXT }, async (harness) => {
    startHero(harness);
    finishHero(harness, HERO_TEXT);
    await harness.followInput();
    harness.input.page.onShow();
    await harness.settlePage(harness.input.page);
    harness.input.page.onShow();
    await harness.settlePage(harness.input.page);
    const audit = harness.audit();
    return [
      check('VRE007.CONSUME_ONCE', audit.handoff.consumeCount === 1, 1, audit.handoff.consumeCount),
      check('VRE007.PARSE_ONCE', audit.input.runParseCount === 1
        && audit.parser.hybridCount === 1, 1, audit),
      check('VRE007.PUBLISH_ONCE', audit.handoff.publishCount === 1, 1, audit.handoff.publishCount)
    ];
  });
}

async function vre008() {
  return withHarness({ caseId: 'VRE-008', text: DIRECT_TEXT }, async (harness) => {
    harness.fakeWx.wx.switchTab({ url: '/pages/input/input' });
    await harness.followInput();
    harness.input.page.startVoice();
    harness.voice.emitStart();
    harness.input.page.stopVoice();
    harness.voice.emitFinal(undefined, DIRECT_TEXT);
    await harness.settlePage(harness.input.page);
    const audit = harness.audit();
    const route = finalRoute(harness.input.page);
    const parserEvidence = audit.parser.voiceInputEvidence[0] || {};
    return [
      check('VRE008.DIRECT_VALID', routeHasValidEvidence(route), true, route),
      check('VRE008.DIRECT_SURFACE', parserEvidence.entrySurface === 'FULL_PAGE'
        && parserEvidence.inputChannel === 'VOICE_TRANSCRIPT',
      { entrySurface: 'FULL_PAGE', inputChannel: 'VOICE_TRANSCRIPT' }, parserEvidence),
      check('VRE008.NO_HANDOFF', audit.handoff.publishCount === 0
        && audit.handoff.consumeCount === 0, 0, audit.handoff),
      check('VRE008.PARSE_ONCE', audit.input.runParseCount === 1
        && audit.parser.hybridCount === 1, 1, audit)
    ];
  });
}

async function vre009() {
  return withHarness({ caseId: 'VRE-009', text: HERO_TEXT }, async (harness) => {
    startHero(harness);
    harness.dispatchHero('move', harness.touch.touchMove([{ identifier: 1, clientX: 120, clientY: 300 }]));
    harness.dispatchHero('end', harness.touch.touchEnd(1, 120, 300));
    harness.voice.emitFinal(undefined, HERO_TEXT);
    const audit = harness.audit();
    return [
      check('VRE009.NO_HANDOFF', audit.handoff.publishCount === 0, 0, audit.handoff.publishCount),
      check('VRE009.NO_NAVIGATION', inputNavigations(audit).length === 0, 0, inputNavigations(audit).length),
      check('VRE009.NO_PARSE', audit.parser.hybridCount === 0, 0, audit.parser.hybridCount),
      check('VRE009.CANCELLED', audit.voice.session && audit.voice.session.status === 'CANCELLED',
        'CANCELLED', audit.voice.session && audit.voice.session.status)
    ];
  });
}

async function vre010() {
  return withHarness({ caseId: 'VRE-010', text: DIRECT_TEXT }, async (harness) => {
    startHero(harness);
    finishHero(harness, DIRECT_TEXT);
    await harness.followInput();
    const audit = harness.audit();
    return [
      check('VRE010.PAGE_TEXT_EXACT', audit.input.text === DIRECT_TEXT, DIRECT_TEXT, audit.input.text),
      check('VRE010.PARSE_ORIGINAL_EXACT', audit.input.originalText === DIRECT_TEXT,
        DIRECT_TEXT, audit.input.originalText),
      check('VRE010.SOURCE_EXACT', audit.input.source === 'voice', 'voice', audit.input.source),
      check('VRE010.ZERO_WRITER', Object.values(audit.input.writerCalls).every((count) => count === 0)
        && audit.businessMutation === false, true, audit)
    ];
  });
}

const EXECUTORS = Object.freeze({
  'VRE-001': vre001,
  'VRE-002': vre002,
  'VRE-003': vre003,
  'VRE-004': vre004,
  'VRE-005': vre005,
  'VRE-006': vre006,
  'VRE-007': vre007,
  'VRE-008': vre008,
  'VRE-009': vre009,
  'VRE-010': vre010
});

async function executeCase(contract) {
  const execute = EXECUTORS[contract.id];
  if (!execute) {
    const error = new Error(`Unknown Voice Record Evidence case: ${contract.id}`);
    error.code = 'TEST_DATA_ERROR';
    throw error;
  }
  const checks = await execute();
  const firstFailure = (checks.find((entry) => !entry.pass) || {}).code || '';
  return {
    checks,
    firstFailure,
    id: contract.id,
    rawStatus: firstFailure ? 'CASE_FAIL' : 'PASS'
  };
}

module.exports = { executeCase };
