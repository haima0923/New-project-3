const CASES = Object.freeze([
  ['VRE-001', 'EXPECTED_RED', 'VRE001.HANDOFF_EVIDENCE_PRESENT'],
  ['VRE-002', 'EXPECTED_RED', 'VRE002.HANDOFF_EVIDENCE_PRESENT'],
  ['VRE-003', 'PASS', ''],
  ['VRE-004', 'PASS', ''],
  ['VRE-005', 'PASS', ''],
  ['VRE-006', 'EXPECTED_RED', 'VRE006.MISMATCH_EVIDENCE_PRESERVED'],
  ['VRE-007', 'PASS', ''],
  ['VRE-008', 'PASS', ''],
  ['VRE-009', 'PASS', ''],
  ['VRE-010', 'PASS', '']
].map(([id, expectedStatus, expectedFirstFailure]) => Object.freeze({
  expectedFirstFailure,
  expectedStatus,
  id
})));

module.exports = { CASES };
