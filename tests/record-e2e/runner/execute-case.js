const { safeClone, stableHash } = require('../../../utils/record-state-diff');
const { createCaseRuntime } = require('./create-case-runtime');
const { sanitizeEvidence } = require('./sanitize-evidence');
const { assertIsolationAudit } = require('./assert-isolation-audit');

function collectFinalAudit(runtime, spec, fixtureBefore) {
  const runtimeAudit = runtime.audit();
  const fixtureAfter = stableHash(spec.initialState.state, 'fixture-before-v1');
  const fixtureMutationAudit = {
    afterFingerprint: fixtureAfter,
    beforeFingerprint: fixtureBefore,
    unchanged: fixtureBefore === fixtureAfter
  };
  const gatewayAudit = runtime.gatewayAudit();
  const finalTransactionAudit = {
    backupCount: gatewayAudit.backupCount
      + (runtimeAudit.storageAudit.backupPresent ? 1 : 0),
    gatewayCount: gatewayAudit.gatewayCount,
    gateways: gatewayAudit.gateways,
    journalCount: gatewayAudit.journalCount
      + (runtimeAudit.storageAudit.journalPresent ? 1 : 0)
  };
  const finalAudit = {
    finalTransactionAudit,
    fixtureMutationAudit,
    hostFilesystemAudit: runtimeAudit.hostFilesystemAudit,
    isolationAuditCompletion: {
      fixtureAuditCompleted: true,
      journalBackupAuditCompleted: true,
      networkAuditCompleted: Boolean(runtimeAudit.networkAudit),
      storageAuditCompleted: Boolean(runtimeAudit.storageAudit),
      workerCleanupCompleted: false
    },
    networkAudit: runtimeAudit.networkAudit,
    storageAudit: runtimeAudit.storageAudit,
    voiceAudit: runtimeAudit.voiceAudit
  };
  try {
    assertIsolationAudit(runtimeAudit);
    if (!fixtureMutationAudit.unchanged) {
      throw Object.assign(new Error('Runner mutated the source State fixture'), {
        code: 'AUTOMATION_FIXTURE_MUTATION_ERROR'
      });
    }
    if (finalTransactionAudit.journalCount || finalTransactionAudit.backupCount) {
      throw Object.assign(new Error('Runner cleanup left Journal or Backup material behind'), {
        code: 'CLEANUP_ERROR'
      });
    }
  } catch (error) {
    error.finalAudit = finalAudit;
    throw error;
  }
  return finalAudit;
}

async function executeCaseInWorker(message) {
  const spec = safeClone(message.spec);
  const plan = safeClone(message.plan);
  const fixtureBefore = stableHash(spec.initialState.state, 'fixture-before-v1');
  const runtime = createCaseRuntime(spec, {
    attempt: message.attempt || 1,
    initialEntries: message.initialEntries
  });
  let evidence = null;
  let finalAudit = null;
  let primaryError = null;
  try {
    // Production modules are intentionally loaded only after Fake wx, the frozen
    // clock, and network guards exist in this isolated process.
    const { executeLanes } = require('./lane-executor');
    evidence = await executeLanes(runtime, spec, plan, {
      attempt: message.attempt || 1,
      hooks: message.hooks || {}
    });
    if (message.hooks && message.hooks.mutateFixture) {
      spec.initialState.state.__runnerFixtureMutationSentinel = true;
    }
  } catch (error) {
    primaryError = error;
    const retainedParserEvidence = runtime.parserObservationEvidence || {};
    if (!primaryError.parserObservation && retainedParserEvidence.parserObservation) {
      primaryError.parserObservation = safeClone(
        retainedParserEvidence.parserObservation
      );
      primaryError.productionPathObservation = safeClone(
        retainedParserEvidence.productionPathObservation || null
      );
    }
    if (message.hooks && message.hooks.forceFinalAuditFailureAfterLaneError) {
      spec.initialState.state.__runnerFinalAuditFailureSentinel = true;
    }
  } finally {
    try {
      finalAudit = collectFinalAudit(runtime, spec, fixtureBefore);
    } catch (auditError) {
      finalAudit = auditError.finalAudit || finalAudit;
      if (primaryError) {
        auditError.parserObservation = safeClone(
          primaryError.parserObservation
          || runtime.parserObservationEvidence
          && runtime.parserObservationEvidence.parserObservation
          || null
        );
        auditError.productionPathObservation = safeClone(
          primaryError.productionPathObservation
          || runtime.parserObservationEvidence
          && runtime.parserObservationEvidence.productionPathObservation
          || null
        );
        auditError.parserObservationCollectionFailure = safeClone(
          primaryError.parserObservationCollectionFailure || null
        );
        auditError.secondaryError = {
          code: primaryError.code || 'AUTOMATION_DRIVER_ERROR',
          message: primaryError.message
        };
      }
      primaryError = auditError;
    }
    runtime.dispose();
    if (finalAudit && finalAudit.isolationAuditCompletion) {
      finalAudit.isolationAuditCompletion.workerCleanupCompleted = true;
    }
  }
  if (primaryError) {
    primaryError.finalAudit = sanitizeEvidence(finalAudit || {});
    primaryError.parserObservation = sanitizeEvidence(
      primaryError.parserObservation || {}
    );
    primaryError.productionPathObservation = sanitizeEvidence(
      primaryError.productionPathObservation || {}
    );
    primaryError.parserObservationCollectionFailure = sanitizeEvidence(
      primaryError.parserObservationCollectionFailure || null
    );
    throw primaryError;
  }
  evidence.caseId = spec.caseId;
  evidence.category = spec.category;
  evidence.clock = safeClone(spec.clock);
  evidence.entrySurface = spec.input.entrySurface;
  evidence.executionPlan = plan;
  evidence.fixtureMutationAudit = finalAudit.fixtureMutationAudit;
  evidence.inputChannel = spec.input.channel;
  evidence.riskLevel = spec.riskLevel;
  evidence.runtimeEvidence = {
    bootId: runtime.bootId,
    pid: process.pid,
    workerIsolation: 'DEDICATED_CHILD_PROCESS'
  };
  evidence.finalTransactionAudit = finalAudit.finalTransactionAudit;
  evidence.hostFilesystemAudit = finalAudit.hostFilesystemAudit;
  evidence.isolationAuditCompletion = finalAudit.isolationAuditCompletion;
  evidence.networkAudit = finalAudit.networkAudit;
  evidence.storageAudit = finalAudit.storageAudit;
  evidence.voiceAudit = finalAudit.voiceAudit;
  return sanitizeEvidence(evidence);
}

module.exports = {
  collectFinalAudit,
  executeCaseInWorker
};
