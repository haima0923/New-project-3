function baseLane(lane) {
  return {
    lane,
    planned: true,
    preconditionsChecked: false,
    preconditionsPassed: false,
    started: false,
    primaryActionAttempted: false,
    primaryActionSucceeded: false,
    completionEvidencePresent: false,
    assertionsCompleted: false,
    completed: false,
    assertions: [],
    evidence: {},
    failureCode: '',
    failureStage: '',
    status: 'PLANNED'
  };
}

function executedLane(lane, evidence = {}, options = {}) {
  return Object.assign(baseLane(lane), {
    preconditionsChecked: true,
    preconditionsPassed: true,
    started: true,
    primaryActionAttempted: true,
    primaryActionSucceeded: options.primaryActionSucceeded !== false,
    completionEvidencePresent: options.completionEvidencePresent !== false,
    evidence,
    failureCode: options.failureCode || '',
    failureStage: options.failureStage || '',
    status: options.status || 'PENDING_ASSERTIONS'
  });
}

function preconditionFailedLane(lane, evidence, failureCode, failureStage) {
  return Object.assign(baseLane(lane), {
    preconditionsChecked: true,
    preconditionsPassed: false,
    completionEvidencePresent: true,
    evidence: evidence || {},
    failureCode,
    failureStage,
    status: 'CASE_FAIL'
  });
}

function missingExecutionEvidence(lane, detail) {
  lane.status = 'RUNNER_ERROR';
  lane.failureCode = 'LANE_EXECUTION_EVIDENCE_MISSING';
  lane.failureStage = 'AUTOMATION_DRIVER_ERROR';
  lane.evidence = Object.assign({}, lane.evidence, {
    missingExecutionEvidence: detail
  });
}

function finalizeLane(lane) {
  lane.assertionsCompleted = true;
  lane.completed = true;
  if (lane.status === 'PENDING_ASSERTIONS') {
    const missing = [
      'planned',
      'preconditionsChecked',
      'preconditionsPassed',
      'started',
      'primaryActionAttempted',
      'primaryActionSucceeded',
      'completionEvidencePresent'
    ].filter((key) => lane[key] !== true);
    if (missing.length) {
      missingExecutionEvidence(lane, missing);
    } else if ((lane.assertions || []).some((assertion) => !assertion.pass)) {
      lane.status = 'CASE_FAIL';
    } else {
      lane.status = 'PASS';
    }
  }
  if (lane.status === 'PASS' && (
    !lane.planned
    || !lane.preconditionsChecked
    || !lane.preconditionsPassed
    || !lane.started
    || !lane.primaryActionAttempted
    || !lane.primaryActionSucceeded
    || !lane.completionEvidencePresent
    || !lane.assertionsCompleted
    || !lane.completed
  )) {
    missingExecutionEvidence(lane, ['PASS_INVARIANT']);
  }
  return lane;
}

module.exports = {
  baseLane,
  executedLane,
  finalizeLane,
  missingExecutionEvidence,
  preconditionFailedLane
};
