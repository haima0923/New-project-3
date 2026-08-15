const CASES = Object.freeze([
  ['P0-HOLD-001', 'GREEN', ''],
  ['P0-HOLD-002', 'GREEN', ''],
  ['TAB-001', 'GREEN', ''],
  ['TAB-002', 'GREEN', ''],
  ['TAB-003', 'GREEN', ''],
  ['TAB-004', 'GREEN', ''],
  ['TAB-005', 'GREEN', ''],
  ['TAB-006', 'GREEN', ''],
  ['HOLD-001', 'GREEN', ''],
  ['HOLD-002', 'GREEN', ''],
  ['HOLD-003', 'GREEN', ''],
  ['HOLD-004', 'GREEN', ''],
  ['HOLD-005', 'GREEN', ''],
  ['HOLD-006', 'GREEN', ''],
  ['HOLD-007', 'GREEN', ''],
  ['HOLD-008', 'GREEN', ''],
  ['HOLD-009', 'GREEN', ''],
  ['HOLD-010', 'GREEN', ''],
  ['HOLD-011', 'GREEN', ''],
  ['HOLD-012', 'GREEN', ''],
  ['HOLD-013', 'GREEN', ''],
  ['HOLD-014', 'GREEN', ''],
  ['HOLD-015', 'GREEN', ''],
  ['HOLD-016', 'GREEN', ''],
  ['HOLD-017', 'GREEN', ''],
  ['HOLD-018', 'GREEN', ''],
  ['ONSET-001', 'GREEN', ''],
  ['ONSET-002', 'GREEN', ''],
  ['ONSET-003', 'GREEN', ''],
  ['ONSET-004', 'GREEN', ''],
  ['ONSET-005', 'GREEN', ''],
  ['ONSET-006', 'GREEN', '']
].map(([id, expected, firstFailure]) => Object.freeze({ expected, firstFailure, id })));

const EXPECTED_BY_ID = Object.freeze(CASES.reduce((output, entry) => {
  output[entry.id] = entry.expected;
  return output;
}, {}));

module.exports = {
  CASES,
  EXPECTED_BY_ID
};
