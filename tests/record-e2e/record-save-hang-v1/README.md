# Record Save Hang V1

Failure-first contracts for the real `pages/input/input` formal-save surface.

This suite is intentionally diagnostic. It dispatches the handler bound by the
real `.formal-save-button`, executes the production `saveConfirmedDraft()` and
`saveState()` chain, and then distinguishes persisted business mutation from
the visible `SAVING` surface.

It does not modify production behavior and does not cover RED-006 replay or
receipt redesign.

Expected baseline before the production fix:

- the static WXML control is green;
- normal Direct, Dashboard Hero voice, and Custom Tab voice saves persist one
  order but leave `showParseProgress=true` (class B: saved once, UI stuck);
- business/storage/post-commit UI faults leave the page permanently locked in
  `SAVING` because the save controller has no failure cleanup;
- the save path does not depend on navigation, but the normal stale progress
  surface still makes the navigation-isolation contract red.

Run:

```sh
node tests/record-e2e/record-save-hang-v1/run.js --repeat 2
```
