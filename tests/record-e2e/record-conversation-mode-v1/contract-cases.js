const CASES = Object.freeze([
  { id: 'CONV-001', title: 'activeQuestion only exposes CLARIFYING' },
  { id: 'CONV-002', title: 'last answer unlocks CONFIRMING' },
  { id: 'CONV-003', title: 'missing product shows question and known facts only' },
  { id: 'CONV-004', title: 'AUTO_REVIEW hides stale/final confirmation' },
  { id: 'CONV-005', title: 'FAST_LOCAL answer confirms without AI' },
  { id: 'CONV-006', title: 'answer-to-AUTO_DEEP really reviews once' },
  { id: 'CONV-007', title: 'answer-to-AUTO_DEEP failures fail closed' },
  { id: 'CONV-008', title: 'no question alone cannot grant confirming' },
  { id: 'CONV-009', title: 'clarifying and confirming are globally exclusive' },
  { id: 'CONV-010', title: 'SAFE_BLOCKED is a separate recovery surface' },
  { id: 'CONV-011', title: 'confirm edit can return to clarifying' },
  { id: 'CONV-012', title: 'presentation state cannot change business semantics' },
  { id: 'GREEN-CONV-001', title: 'complete single item reaches confirming' },
  { id: 'GREEN-CONV-002', title: 'clarification answer reaches confirming' },
  { id: 'GREEN-CONV-003', title: 'complete multi item deep reaches confirming' }
]);

const GREEN_CONTROLS = new Set(CASES.filter((entry) => entry.id.startsWith('GREEN-')).map((entry) => entry.id));

module.exports = { CASES, GREEN_CONTROLS };
