const CONTRACTS = Object.freeze([
  ['LEASE-001', 'PASS', ''],
  ['LEASE-002', 'PASS', ''],
  ['LEASE-003', 'PASS', ''],
  ['LEASE-004', 'CASE_FAIL', 'LEASE004.FILE_A_NEVER_BINDS_B'],
  ['LEASE-005', 'PASS', ''],
  ['LEASE-006', 'PASS', ''],
  ['LEASE-007', 'CASE_FAIL', 'LEASE007.EARLY_STOP_FAILS_CLOSED_NOT_PREPARING'],
  ['LEASE-008', 'CASE_FAIL', 'LEASE008.EARLY_STOP_ENTERS_DESYNC'],
  ['LEASE-009', 'CASE_FAIL', 'LEASE009.ERROR_POISONS_CURRENT_NATIVE_EPOCH'],
  ['LEASE-010', 'PASS', ''],
  ['LEASE-011', 'CASE_FAIL', 'LEASE011.NATIVE_LEASE_ID_PRESENT_AND_DISTINCT'],
  ['LEASE-012', 'CASE_FAIL', 'LEASE012.NATIVE_LEASE_ID_STABLE'],
  ['LEASE-013', 'PASS', ''],
  ['LEASE-014', 'PASS', ''],
  ['LEASE-015', 'PASS', ''],
  ['LEASE-016', 'CASE_FAIL', 'LEASE016.STOP_THROW_QUARANTINES_NATIVE_EPOCH'],
  ['GREEN-LEASE-001', 'PASS', ''],
  ['GREEN-LEASE-002', 'PASS', ''],
  ['GREEN-LEASE-003', 'PASS', '']
].map(([id, expectedStatus, expectedFirstFailure]) => Object.freeze({
  expectedFirstFailure,
  expectedStatus,
  id
})));

module.exports = {
  CONTRACTS,
  CONTRACT_BY_ID: new Map(CONTRACTS.map((contract) => [contract.id, contract]))
};
