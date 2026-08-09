const ALLOWED_SOURCES = new Set(['typed', 'paste', 'voice']);

let currentEntryHandoff = null;

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
  return Object.freeze({
    autoParse: true,
    originSurface: 'HOME_QUICK',
    originalText,
    source
  });
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
  return Object.freeze({
    autoParse: payload.autoParse,
    originSurface: payload.originSurface,
    originalText: payload.originalText,
    source: payload.source
  });
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
