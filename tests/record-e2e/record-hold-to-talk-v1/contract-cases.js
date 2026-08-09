const CASES = Object.freeze([
  ['P0-HOLD-001', 'RED', 'HIDDEN_TIMER_PROVIDER_ZERO'],
  ['P0-HOLD-002', 'RED', 'ACTIVE_HIDE_UI_IDLE'],
  ['TAB-001', 'RED', 'TAB_NO_DASHBOARD_NAV_AT_START'],
  ['TAB-002', 'RED', 'TAB_ONE_GESTURE_START_ONCE'],
  ['TAB-003', 'RED', 'TAB_DIRECT_INPUT_NAV_ONLY'],
  ['TAB-004', 'RED', 'TAB_VERTICAL_CANCELLED'],
  ['TAB-005', 'RED', 'TAB_SHORT_PROMPT'],
  ['TAB-006', 'RED', 'TAB_TOUCHCANCEL_NO_NAV'],
  ['HOLD-001', 'RED', 'HERO_SHORT_PROMPT'],
  ['HOLD-002', 'GREEN', ''],
  ['HOLD-003', 'GREEN', ''],
  ['HOLD-004', 'RED', 'VERTICAL_PURE'],
  ['HOLD-005', 'RED', 'SLIDE_BACK_ENTERED_CANCEL'],
  ['HOLD-006', 'RED', 'HERO_SECOND_TOUCH_NO_GESTURE_CHANGE'],
  ['HOLD-007', 'RED', 'HIDE_TIMER_DEAD'],
  ['HOLD-008', 'RED', 'PERMISSION_AFTER_RELEASE_NO_START'],
  ['HOLD-009', 'RED', 'LATE_ONSTART_NOT_LISTENING'],
  ['HOLD-010', 'RED', 'PROVIDER_STOP_EXACTLY_ONCE'],
  ['HOLD-011', 'GREEN', ''],
  ['HOLD-012', 'GREEN', ''],
  ['HOLD-013', 'RED', 'TYPED_INVALIDATES_OLD_FINAL'],
  ['HOLD-014', 'GREEN', ''],
  ['HOLD-015', 'RED', 'FINALIZING_REPRESS_FEEDBACK'],
  ['HOLD-016', 'GREEN', ''],
  ['HOLD-017', 'RED', 'TAB_CANNOT_END_HERO_OWNER'],
  ['HOLD-018', 'GREEN', '']
].map(([id, expected, firstFailure]) => Object.freeze({ expected, firstFailure, id })));

const EXPECTED_BY_ID = Object.freeze(CASES.reduce((output, entry) => {
  output[entry.id] = entry.expected;
  return output;
}, {}));

module.exports = {
  CASES,
  EXPECTED_BY_ID
};
