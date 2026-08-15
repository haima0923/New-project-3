# WechatSI Readiness UX V1 — Hold-to-talk contracts

This suite freezes the shared Dashboard Hero and Custom Tab microphone flow. It
loads production `Page`, `Component`, `utils/voice-recognition.js`, and the real
in-memory entry handoff. It is a Page/Component VM contract suite, **not** a
WeChat DevTools renderer or a real-device acoustic test.

## Frozen readiness semantics

```text
touchstart → PREPARING → provider onStart
→ POST_ONSTART_STABILIZING (699 ms: not ready)
→ 700 ms: READY_RECORDING + one medium vibration
→ touchend → final → exact R1B handoff → Input Conversation
```

- Acquisition starts with the gesture; the retired 260 ms rule has no capture,
  readiness, or send authority.
- Only the current provider `onStart` starts the 700 ms timer. CSS animation is
  visual only.
- Before 700 ms, release/cancel/lifecycle loss discards the session: vibration,
  accepted final, handoff, Input parse, business, and storage are all zero. The
  visible feedback is `请等震动后再说`.
- At 700 ms, READY and `vibrateShort({ type: 'medium' })` happen exactly once.
  A vibration failure does not revoke READY.
- Vertical, left-up, and right-up moves cancel. A cancelled or invalidated
  session cannot be re-armed by moving back.
- Permission granted during a gesture is deliberately next-gesture-only:
  `麦克风已开启，请重新按住说话`.
- Owner identity, touch identity, stale callbacks, typed/paste replacement,
  hide/unload/detach, and final-once all fail closed. Dashboard and Custom Tab
  never parse or save; Input remains the only Conversation/confirm/save owner.

Two iPhone device runs are frozen as historical readiness evidence: after a
real provider `onStart` plus 700 ms, the user spoke the fixed sentence and the
recording retained the opening `冯总`. This suite does not claim to reproduce
that acoustic evidence. Android remains a separate coverage item.

## Migration ledger

`MIGRATE` means the invariant remains but its legal timing is now provider
`onStart + 700 ms`. `SUPERSEDED` means the old timing/prompt assumption was
retired. No row was classified as a production regression.

| ID | Historical contract | Current contract | Verdict | Runner / README change |
| --- | --- | --- | --- | --- |
| P0-HOLD-001 | hide cleared a 260 ms pending hold | hide revokes PREPARING/STABILIZING timer and provider authority | MIGRATE | wait/replay 700 ms, document lifecycle |
| P0-HOLD-002 | hide of active immediate-ready recording | hide clears ready/stabilizing state; show permits a fresh 700 ms capture | MIGRATE | resume through onStart + 700 ms |
| TAB-001 | cross-tab 260 ms Dashboard relay timing | Custom Tab acquires immediately without Dashboard relay | MIGRATE | assert immediate provider start |
| TAB-002 | 259/260/261 qualification starts/sends | 699/700 readiness boundary and legal release | SUPERSEDED | replace threshold assertions |
| TAB-003 | final after old qualified hold | final only after Tab READY | MIGRATE | drive onStart + 700 ms |
| TAB-004 | cancellation around old threshold | cancel before/after readiness has zero authority | MIGRATE | drive ready only for valid send |
| TAB-005 | short press showed `请按住说话` | pre-ready release shows `请等震动后再说` | SUPERSEDED | update prompt and timing |
| TAB-006 | Tab touch identity during immediate ready | identity remains valid through stabilization | MIGRATE | await READY before owner terminal action |
| HOLD-001 | Hero short tap at 260 ms | Hero pre-ready release discards after provider start | SUPERSEDED | replace 260 ms / old prompt |
| HOLD-002 | Hero 259/260/261 send threshold | Hero 699/700 readiness boundary | SUPERSEDED | replace threshold assertions |
| HOLD-003 | normal Hero final immediately after onStart | normal final after Hero READY | MIGRATE | shared ready helper |
| HOLD-004 | directional cancel of old qualified hold | pure/left/right upward cancel before send authority | MIGRATE | enter READY only for valid comparison |
| HOLD-005 | slide-back behavior around old hold timer | current live capture may recover only before invalidation; invalid sessions never re-arm | MIGRATE | preserve identity/invalidity gates |
| HOLD-006 | touch identity on immediate-ready capture | initiating identifier remains owner across stabilization | MIGRATE | await READY before terminal owner end |
| HOLD-007 | timer lifecycle at old 260 ms | lifecycle clears pre-ready/ready timers and callbacks | MIGRATE | replay after 700 ms |
| HOLD-008 | permission callback joined pending capture | permission/cancel/hide remain next-gesture-only and zero authority | SUPERSEDED | latest callback driver; no late capture |
| HOLD-009 | permission late-start UI sequence | no provider start for invalidated permission gesture | SUPERSEDED | assert zero start/stop/handoff |
| HOLD-010 | early release timing | pre-ready release stops/discards once | MIGRATE | use post-onStart readiness path |
| HOLD-011 | duplicate final/error after immediate ready | duplicate terminal events stay idempotent after READY | MIGRATE | shared ready helper |
| HOLD-012 | stale A final vs B immediate recording | stale A cannot affect B after B reaches READY | MIGRATE | B waits 700 ms |
| HOLD-013 | typed/paste replace immediate-ready voice | typed/paste invalidate pre/ready voice and stale final | MIGRATE | valid source waits READY |
| HOLD-014 | duplicate provider final | accepted final remains exactly once after READY | MIGRATE | shared ready helper |
| HOLD-015 | old busy feedback wording | readiness-aware busy feedback remains user-visible | MIGRATE | accept current recording-processing wording |
| HOLD-016 | timer stale after capture turnover | stale timer/final has zero authority after invalidation | MIGRATE | replay after current readiness window |
| HOLD-017 | cross-entry owner terminal tests | Hero/Tab owner isolation through stabilization | MIGRATE | Tab valid owner waits READY |
| HOLD-018 | Hero/Tab semantic equivalence | both surfaces hand off only from READY | MIGRATE | shared ready helper |
| ONSET-001 | start at touch + 260 ms qualified | start at touch; 699/700 readiness authority | SUPERSEDED | replace onset threshold |
| ONSET-002 | Hero/Tab onset parity | Hero/Tab provider-start parity remains | KEEP | no semantic change |
| ONSET-003 | short press had no provider start and old prompt | provider starts, then short/pre-ready release discards | SUPERSEDED | replace outcome/prompt |
| ONSET-004 | long hold final after 260 ms | final exactly once after READY | MIGRATE | wait 700 ms |
| ONSET-005 | hide before 260 ms | hide before READY revokes provider/timer/final authority | MIGRATE | replay after 700 ms |
| ONSET-006 | permission completion resumed same utterance | first approval is next-gesture-only | SUPERSEDED | latest permission callback driver |

## Runner contract

Run:

```sh
node tests/record-e2e/record-hold-to-talk-v1/run.js --repeat 2
```

The migrated baseline is all-green: a case assertion is `CASE_FAIL`; missing
handlers, fixture defects, runtime failures, or instability are `RUNNER_ERROR`.
Expected result is `PASS=32`, `CASE_FAIL=0`, `RUNNER_ERROR=0`, and
`DETERMINISM=STABLE`.

This README preserves the historical contracts above instead of deleting their
evidence. It does not authorize a production change, an ASR integration, or a
claim that VM evidence is real-device acoustic evidence.
