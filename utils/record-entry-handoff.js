const ALLOWED_SOURCES = new Set(['typed', 'paste', 'voice']);
const INPUT_CHANNEL_BY_SOURCE = Object.freeze({
  paste: 'PASTE_TEXT',
  typed: 'MANUAL_TEXT',
  voice: 'VOICE_TRANSCRIPT'
});
const VOICE_ORIGIN_SURFACES = new Set([
  'CUSTOM_TAB_CENTER',
  'DASHBOARD_HERO',
  'HOME_QUICK'
]);
const VOICE_EVIDENCE_FIELDS = Object.freeze([
  'version',
  'status',
  'isFinal',
  'source',
  'provider',
  'sessionId',
  'utteranceId',
  'resultSequence',
  'callbackName',
  'startedAt',
  'completedAt',
  'transcriptFingerprint',
  'transcriptLength',
  'transcriptSourceField',
  'evidenceSource'
]);

let currentEntryHandoff = null;

function cloneVoiceCompletionEvidence(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const evidence = VOICE_EVIDENCE_FIELDS.reduce((output, key) => {
    if (!Object.prototype.hasOwnProperty.call(input, key)) return output;
    if (key === 'isFinal') output[key] = input[key] === true;
    else if (key === 'resultSequence' || key === 'transcriptLength') {
      output[key] = Number.isFinite(Number(input[key])) ? Number(input[key]) : 0;
    } else output[key] = String(input[key] || '');
    return output;
  }, {});
  return Object.freeze(evidence);
}

function normalizeEntryHandoff(input = {}) {
  const originalText = String(input.originalText || '');
  const source = String(input.source || '');
  if (!originalText.trim()) {
    const error = new Error('Record entry handoff requires original text');
    error.code = 'ENTRY_HANDOFF_TEXT_REQUIRED';
    throw error;
  }
  if (!ALLOWED_SOURCES.has(source)) {
    const error = new Error('Record entry handoff source is not supported');
    error.code = 'ENTRY_HANDOFF_SOURCE_UNSUPPORTED';
    throw error;
  }
  const requestedOriginSurface = String(input.originSurface || '');
  const originSurface = source === 'voice' && VOICE_ORIGIN_SURFACES.has(requestedOriginSurface)
    ? requestedOriginSurface
    : 'HOME_QUICK';
  const payload = {
    autoParse: true,
    inputChannel: INPUT_CHANNEL_BY_SOURCE[source],
    originSurface,
    originalText,
    source
  };
  const voiceCompletionEvidence = source === 'voice'
    ? cloneVoiceCompletionEvidence(input.voiceCompletionEvidence)
    : null;
  if (voiceCompletionEvidence) payload.voiceCompletionEvidence = voiceCompletionEvidence;
  return Object.freeze(payload);
}

function publishRecordEntryHandoff(input) {
  const payload = normalizeEntryHandoff(input);
  const handle = Object.freeze({});
  currentEntryHandoff = { handle, payload };
  return handle;
}

function hasPendingRecordEntryHandoff() {
  return Boolean(currentEntryHandoff);
}

function consumeRecordEntryHandoff() {
  if (!currentEntryHandoff) return null;
  const payload = currentEntryHandoff.payload;
  currentEntryHandoff = null;
  return normalizeEntryHandoff(payload);
}

function invalidateRecordEntryHandoff(handle) {
  if (!currentEntryHandoff || currentEntryHandoff.handle !== handle) return false;
  currentEntryHandoff = null;
  return true;
}

module.exports = {
  consumeRecordEntryHandoff,
  hasPendingRecordEntryHandoff,
  invalidateRecordEntryHandoff,
  publishRecordEntryHandoff
};
