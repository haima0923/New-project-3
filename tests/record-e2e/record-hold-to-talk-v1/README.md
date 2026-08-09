# Record Hold-to-talk V1 failure-first contracts

This suite freezes the joint Dashboard Hero and custom-tab center microphone contract.
It is a test-only paving step: it does not implement the shared controller.

## Evidence layers

- `STATIC_SOURCE`: real Dashboard and custom-tab WXML touch bindings are extracted.
- `PAGE_VM`: the production Dashboard `Page` and custom-tab `Component` are loaded.
- `VOICE_RUNTIME`: the real `utils/voice-recognition.js` owns permission, session,
  stop, cancel, final evidence, and stale callback decisions. The test manager never
  auto-finalizes.
- `VIRTUAL_TIME`: 259/260/261 ms and cancellation boundaries use one monotonic fake
  clock shared by the Page, Component, and voice module. No real sleeps are used.
- `ENTRY_FLOW`: a legal final uses the real in-memory record-entry handoff and the
  real Input `onShow`/`runParse` Conversation controller.

This is not `REAL_WXML`; no WeChat DevTools renderer is claimed in this phase.

## Product contract

- Both entry points mean: press and hold, release to send, vertical swipe up to
  cancel, slide back to send, and a visible short-tap prompt `请按住说话`.
- A custom-tab press never navigates to Dashboard to acquire voice. Only an accepted
  final may navigate directly to `/pages/input/input`.
- `onHide`, `onUnload`, component detach, touchcancel, typed/paste replacement, and
  stale callbacks fail closed.
- A press owner includes the entry surface and initiating touch identifier. A second
  finger or entry cannot stop/cancel the owner's capture.
- Provider stop and accepted final are exactly once. Dashboard parse/save remains
  unreachable; Input Conversation remains the only parse/confirm/save authority.

## Architecture verdict

Two independent gesture implementations are rejected. The production phase should
introduce one page-agnostic hold controller shared by Dashboard Hero and custom-tab.
The controller owns active press, touch identifier, timer, voice session, permission
epoch, terminal once gate, stale-final invalidation, transcript, and handoff. Page
`onHide` and Component `detached` notify the controller; neither page owns business
parse/save authority.

## Runner contract

Run:

```sh
node tests/record-e2e/record-hold-to-talk-v1/run.js --repeat 2
```

- exit `1`: stable expected production RED with every GREEN control passing;
- exit `2`: runner error, unstable result, GREEN failure, or baseline drift;
- exit `0`: all contracts pass after the future production implementation and an
  intentional baseline migration.

Case assertion failures are `CASE_FAIL`. Missing production handlers, invalid test
fixtures, timeouts, host I/O, or runtime failures are `RUNNER_ERROR`.
