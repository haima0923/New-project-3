# Record Entry Unification V1 failure-first contract

This suite freezes the R1B boundary in which Dashboard typed, paste, and
already-final voice transcripts become acquisition-only entry points for the
existing `pages/input` Conversation flow.

## Evidence layers

- `STATIC_SOURCE`: extracts the real Dashboard WXML handlers. It does not claim
  browser or Mini Program rendering.
- `DASHBOARD_PAGE_VM`: invokes production Dashboard page methods and observes
  parser, save, Deep, business, storage, and old-modal reachability.
- `INPUT_PAGE_VM`: loads the production Input page in the same fake WeChat and
  app/module lifetime, follows the handoff, and observes Conversation semantics.
- `CONTROLLED_HANDOFF`: controls `switchTab` success, failure, throw, repetition,
  and out-of-order callbacks while observing a real shared production handoff
  module if one exists. The test never substitutes its own registry as authority.

`REAL_WXML` and real-device behavior are explicitly not run in this phase.

## Handoff contract (historical R1B baseline)

The intended production design is a module-private, process-memory, one-slot
handoff with generation-bound handles:

1. `publish()` copies the exact R1B allowlist: `originalText`, `source`,
   `originSurface`, and `autoParse`. The destination re-analyzes paste text, so
   no parsed paste structure or control-plane metadata crosses this boundary.
2. A new publish replaces an older unconsumed generation deterministically.
3. `consume()` atomically clears the slot before returning the copied payload.
4. `invalidate(handle)` clears only when the handle is still the current
   generation, so a late failure for A cannot erase newer B.
5. Navigation success does not apply data. `pages/input.onShow()` is the sole
   consumer and starts the real parse exactly once.
6. Navigation failure or synchronous throw revokes the exact generation and
   leaves a recoverable Dashboard input without falling back to the old card.

A closure identity is sufficient for typed/paste and transcript-only voice
handoffs. R1B deliberately freezes transcript plus source and does not transfer
voice authority. `WeakMap` would be needed only if a later, separately tested
contract carries an opaque voice-evidence reference. Existing voice evidence is
not assumed to be intrinsically non-serializable.

The handoff must not use business/local Storage or query parameters. Storage
would retain stale input across later page visits and could accidentally turn
route, proof, or save eligibility into persisted authority. `switchTab` does not
provide a reliable query transfer boundary for this tab page.

## Current voice extension (verified 2026-10-28)

The four-field contract above is the historical R1B contract. Commit `3a5ebb9`
later extended the production handoff to preserve voice provenance. Do not remove
that extension to satisfy the frozen failure-first assertions below.

- Every normalized payload also contains `inputChannel`, derived from `source`:
  `MANUAL_TEXT`, `PASTE_TEXT`, or `VOICE_TRANSCRIPT`. Caller-supplied channels
  cannot override this mapping.
- Voice may additionally carry a copied, allowlisted `voiceCompletionEvidence`.
  Typed and paste payloads discard this field. Voice origins are `HOME_QUICK`,
  `DASHBOARD_HERO`, or `CUSTOM_TAB_CENTER`.
- The actual destination is still `FULL_PAGE`. For voice, the parser's
  `entrySurface=HOME_QUICK` describes acquisition provenance; it does not mean
  that Dashboard has parsed or saved the draft. Typed and paste parse with
  `entrySurface=FULL_PAGE`.
- The destination revalidates voice session/fingerprint evidence. Route,
  provider trust, manual proofs, parsed fields and save authority are never
  accepted as handoff metadata. One-slot generation and consume-once rules
  remain unchanged.

Current checks use the offline wrapper's `entry-handoff` and `flow-gate` suites.
The former checks exact normalized payloads, copying, rejected extra fields and
late failures; the latter follows production page methods through one navigation,
one consume and one parse, preserving the exact original input with no early save.
Neither suite claims real WXML rendering, microphone capture or device behavior.

## Baseline

The frozen production baseline is 15 stable `CASE_FAIL` results, with
`ENTRY-011` and the three `GREEN-ENTRY` controls passing. A valid failure-first
run therefore reports:

```text
CONTRACT_GATE=EXPECTED_RED
ROUNDS=2
DETERMINISM=STABLE
PASS=4 CASE_FAIL=15 RUNNER_ERROR=0
REAL_WXML=NOT_RUN_THIS_PHASE
```

Run with:

```sh
node tests/record-e2e/record-entry-unification-v1/run.js --repeat 2
```

## Scope boundary

The suite does not test or change Dashboard hold-to-talk gestures, custom tab
behavior, AMOUNT_CHOICE, RED-006, production WXML/WXSS, parser rules, business,
storage, server, or existing expected files.
