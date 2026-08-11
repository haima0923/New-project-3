const CONTRACTS = Object.freeze([
  ['LEASE-001', 'PASS', ''],
  ['LEASE-002', 'PASS', ''],
  ['LEASE-003', 'PASS', ''],
  ['LEASE-004', 'PASS', ''],
  ['LEASE-005', 'PASS', ''],
  ['LEASE-006', 'PASS', ''],
  ['LEASE-007', 'PASS', ''],
  ['LEASE-008', 'PASS', ''],
  ['LEASE-009', 'PASS', ''],
  ['LEASE-010', 'PASS', ''],
  ['LEASE-011', 'PASS', ''],
  ['LEASE-012', 'PASS', ''],
  ['LEASE-013', 'PASS', ''],
  ['LEASE-014', 'PASS', ''],
  ['LEASE-015', 'PASS', ''],
  ['LEASE-016', 'PASS', ''],
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
