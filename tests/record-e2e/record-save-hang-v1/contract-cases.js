const CASES = Object.freeze([
  { id: 'GREEN-SAVE-HANG-001', expectedStatus: 'PASS', expectedFirstFailure: '' },
  { id: 'SAVE-HANG-001', expectedStatus: 'CASE_FAIL', expectedFirstFailure: 'SAVE001.PROGRESS_CLEARED' },
  { id: 'SAVE-HANG-002', expectedStatus: 'CASE_FAIL', expectedFirstFailure: 'SAVE002.DIRECT_EXITED' },
  { id: 'SAVE-HANG-003', expectedStatus: 'CASE_FAIL', expectedFirstFailure: 'SAVE003.HERO_EXITED' },
  { id: 'SAVE-HANG-004', expectedStatus: 'CASE_FAIL', expectedFirstFailure: 'SAVE004.SUCCESS_SURFACE_EXITED' },
  { id: 'SAVE-HANG-005-BUSINESS', expectedStatus: 'CASE_FAIL', expectedFirstFailure: 'SAVE005B.RECOVERED_FROM_THROW' },
  { id: 'SAVE-HANG-005-STORAGE', expectedStatus: 'CASE_FAIL', expectedFirstFailure: 'SAVE005S.RECOVERED_FROM_THROW' },
  { id: 'SAVE-HANG-005-POSTCOMMIT', expectedStatus: 'CASE_FAIL', expectedFirstFailure: 'SAVE005P.RECOVERED_AFTER_COMMIT' },
  { id: 'SAVE-HANG-005-NAVIGATION', expectedStatus: 'CASE_FAIL', expectedFirstFailure: 'SAVE005N.PROGRESS_CLEARED' }
]);

module.exports = { CASES };
