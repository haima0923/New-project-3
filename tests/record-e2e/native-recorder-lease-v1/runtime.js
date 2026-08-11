const fs = require('fs');
const path = require('path');
const { safeClone } = require('../../../utils/record-state-diff');
const { ROOT } = require('../runner/constants');
const { createVcapHarness, extractBindings } = require('../voice-capture-v2/runtime');
const { audioPayload } = require('./recorder-runtime');

const CONTROLLER_PATH = path.join(ROOT, 'utils/hold-to-talk-controller.js');

function start(harness, surface = 'hero', identifier = 1, point = {}) {
  return harness.dispatch(surface, 'start', harness.touch.touchStart(
    identifier,
    Number.isFinite(point.x) ? point.x : 200,
    Number.isFinite(point.y) ? point.y : 400,
    point.extraTouches || []
  ));
}

function end(harness, surface = 'hero', identifier = 1) {
  return harness.dispatch(surface, 'end', harness.touch.touchEnd(identifier, 200, 400));
}

function cancel(harness, surface = 'hero', identifier = 1) {
  return harness.dispatch(surface, 'cancel', harness.touch.touchEnd(identifier, 200, 400));
}

function controllerSource() {
  return fs.existsSync(CONTROLLER_PATH) ? fs.readFileSync(CONTROLLER_PATH, 'utf8') : '';
}

function functionBody(source, name) {
  const startIndex = source.indexOf(`function ${name}(`);
  if (startIndex < 0) return '';
  const brace = source.indexOf('{', startIndex);
  if (brace < 0) return '';
  let depth = 0;
  let quote = '';
  for (let index = brace; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote && source[index - 1] !== '\\') quote = '';
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') depth -= 1;
    if (depth === 0) return source.slice(brace + 1, index);
  }
  return '';
}

function snapshot(harness) {
  const audit = harness.audit();
  return safeClone({
    audio: audit.controller && audit.controller.audio || null,
    businessMutation: audit.businessMutation,
    captureId: audit.controller && audit.controller.captureId || '',
    gesture: audit.controller && audit.controller.gesture || '',
    handoffCount: audit.handoff.publishCount,
    legacyStartCount: audit.legacyVoice.startCount,
    nativeLeaseId: audit.controller && audit.controller.nativeLeaseId || '',
    navigation: audit.navigation.map((entry) => String(entry.url || '')),
    phase: audit.controller && audit.controller.phase || 'UNAVAILABLE',
    recorder: audit.recorder,
    storageMutationCount: audit.storageMutations.length,
    surface: audit.controller && audit.controller.surface || '',
    vibrationCount: audit.vibrationCount,
    view: audit.view
  });
}

function withHarness(options, callback) {
  const harness = createVcapHarness(options);
  try {
    return callback(harness);
  } finally {
    harness.dispose();
  }
}

module.exports = {
  CONTROLLER_PATH,
  audioPayload,
  cancel,
  controllerSource,
  end,
  extractBindings,
  functionBody,
  snapshot,
  start,
  withHarness
};
