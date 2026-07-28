const { safeClone, stableHash } = require('../../../utils/record-state-diff');
const { createCaseRuntime } = require('./create-case-runtime');
const { sanitizeEvidence } = require('./sanitize-evidence');

async function executeCaseInWorker(message) {
  const spec = safeClone(message.spec);
  const plan = safeClone(message.plan);
  const fixtureBefore = stableHash(spec.initialState.state, 'fixture-before-v1');
  const runtime = createCaseRuntime(spec, {
    attempt: message.attempt || 1,
    initialEntries: message.initialEntries
  });
  try {
    // Production modules are intentionally loaded only after Fake wx, the frozen
    // clock, and network guards exist in this isolated process.
    const { executeLanes } = require('./lane-executor');
    const evidence = await executeLanes(runtime, spec, plan, {
      attempt: message.attempt || 1,
      hooks: message.hooks || {}
    });
    const fixtureAfter = stableHash(spec.initialState.state, 'fixture-before-v1');
    evidence.caseId = spec.caseId;
    evidence.category = spec.category;
    evidence.clock = safeClone(spec.clock);
    evidence.entrySurface = spec.input.entrySurface;
    evidence.executionPlan = plan;
    evidence.fixtureMutationAudit = {
      afterFingerprint: fixtureAfter,
      beforeFingerprint: fixtureBefore,
      unchanged: fixtureBefore === fixtureAfter
    };
    evidence.inputChannel = spec.input.channel;
    evidence.riskLevel = spec.riskLevel;
    evidence.runtimeEvidence = {
      bootId: runtime.bootId,
      pid: process.pid,
      workerIsolation: 'DEDICATED_CHILD_PROCESS'
    };
    return sanitizeEvidence(evidence);
  } finally {
    runtime.dispose();
  }
}

module.exports = {
  executeCaseInWorker
};
