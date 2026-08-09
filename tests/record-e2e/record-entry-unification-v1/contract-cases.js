const CASES = Object.freeze([
  { id: 'ENTRY-001', title: 'dashboard typed input hands off to one Conversation flow' },
  { id: 'ENTRY-002', title: 'dashboard paste preserves raw text and shares Conversation semantics' },
  { id: 'ENTRY-003', title: 'dashboard voice final hands off without testing hold gesture' },
  { id: 'ENTRY-004', title: 'direct and dashboard sources have equal business semantics' },
  { id: 'ENTRY-005', title: 'legacy dashboard confirmation modal is unreachable' },
  { id: 'ENTRY-006', title: 'legacy dashboard formal and pending saves are unreachable' },
  { id: 'ENTRY-007', title: 'legacy dashboard manual Deep is unreachable' },
  { id: 'ENTRY-008', title: 'handoff is consumed exactly once' },
  { id: 'ENTRY-009', title: 'consumed handoff cannot replay over new input' },
  { id: 'ENTRY-010', title: 'latest unconsumed handoff wins deterministically' },
  { id: 'ENTRY-011', title: 'input page without handoff remains INPUT' },
  { id: 'ENTRY-012', title: 'lifecycle callbacks cannot duplicate auto parse' },
  { id: 'ENTRY-013', title: 'handoff excludes trusted control-plane state' },
  { id: 'ENTRY-014', title: 'legacy modal source cannot become reachable' },
  { id: 'ENTRY-015', title: 'navigation failure revokes handoff and fails safely' },
  { id: 'ENTRY-016', title: 'entry unification performs no business mutation before final save' },
  { id: 'GREEN-ENTRY-001', title: 'direct input without handoff still shows INPUT' },
  { id: 'GREEN-ENTRY-002', title: 'existing input Conversation flow remains intact' },
  { id: 'GREEN-ENTRY-003', title: 'dashboard non-input navigation remains intact' }
]);

const GREEN_CONTROLS = new Set(
  CASES.filter((entry) => entry.id.startsWith('GREEN-')).map((entry) => entry.id)
);

module.exports = { CASES, GREEN_CONTROLS };
