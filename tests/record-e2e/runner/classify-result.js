function classifyWorkerError(error) {
  const code = String(error && error.code || 'AUTOMATION_DRIVER_ERROR');
  if (code === 'TEST_DATA_ERROR') return {
    caseStatus: 'BLOCKED',
    failureCode: code,
    failureStage: 'TEST_DATA_ERROR'
  };
  if (code === 'AUTOMATION_NETWORK_GUARD_ERROR') return {
    caseStatus: 'RUNNER_ERROR',
    failureCode: code,
    failureStage: 'AUTOMATION_NETWORK_GUARD_ERROR'
  };
  if ([
    'AUTOMATION_FIXTURE_MUTATION_ERROR',
    'ISOLATION_AUDIT_NOT_EXECUTED',
    'LANE_EXECUTION_EVIDENCE_MISSING'
  ].includes(code)) return {
    caseStatus: 'RUNNER_ERROR',
    failureCode: code,
    failureStage: 'AUTOMATION_DRIVER_ERROR'
  };
  if (/STORAGE|LEGACY_SAVE|CLEANUP/.test(code)) return {
    caseStatus: 'RUNNER_ERROR',
    failureCode: code,
    failureStage: 'STORAGE_TRANSACTION_ERROR'
  };
  return {
    caseStatus: 'RUNNER_ERROR',
    failureCode: code,
    failureStage: 'AUTOMATION_DRIVER_ERROR'
  };
}

module.exports = {
  classifyWorkerError
};
