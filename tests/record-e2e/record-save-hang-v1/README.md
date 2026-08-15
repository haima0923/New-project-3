# Record Save Hang V1

Contracts for the real `pages/input/input` formal-save surface. The suite invokes
the handler bound by `.formal-save-button`, then distinguishes persisted business
mutation from the visible `SAVING` surface.

It covers the formal-save completion repair only; it does not cover RED-006
replay or receipt redesign.

## Baseline migration — WechatSI Readiness UX V1

The historical failure-first baseline predated the Completion V1 production fix
and the frozen WechatSI readiness flow. It expected selected save cases to stay
red, and its voice fixture did this:

```text
touchstart → advance 260 ms → provider onStart → immediate end/final
```

That driver is now an invalid pre-ready release: no handoff or Input parse should
occur. It caused `SAVE-HANG-002` and `SAVE-HANG-003` to report
`Voice final did not navigate to Input` as `RUNNER_ERROR`; it was not a save,
business, storage, parser, or production readiness regression.

The test-only fixture is migrated to the current legal voice path:

```text
touchstart → provider onStart → advance 700 ms → READY → end/final
```

All nine contract expectations are therefore intentionally migrated to `PASS`:

| Cases | Historical state | Current expected state | Classification |
| --- | --- | --- | --- |
| GREEN-SAVE-HANG-001, SAVE-HANG-001 | static/direct save control | formal save completes and leaves `SAVING` | KEEP |
| SAVE-HANG-002, SAVE-HANG-003 | stale 260 ms voice fixture failed before Input | legal 700 ms voice reaches Input, confirms, saves once, exits `SAVING` | MIGRATE |
| SAVE-HANG-004 | saved-error cleanup baseline | UI cleanup remains complete | MIGRATE |
| SAVE-HANG-005-BUSINESS | business failure cleanup baseline | no persisted order; UI returns to confirming | MIGRATE |
| SAVE-HANG-005-STORAGE | storage failure cleanup baseline | no persisted order; UI returns to confirming | MIGRATE |
| SAVE-HANG-005-POSTCOMMIT | post-commit presentation fault baseline | exactly one commit; UI cleanup completes | MIGRATE |
| SAVE-HANG-005-NAVIGATION | navigation isolation baseline | no duplicate save or stuck `SAVING` | MIGRATE |

No expected value was changed merely to hide a failure: this suite first runs the
same production formal-save path and checks exactly-once business/storage,
`showParseProgress=false`, `savingInProgress=false`, and the terminal UI state.

## Runner contract

```sh
node tests/record-e2e/record-save-hang-v1/run.js --repeat 2
```

Expected migrated result is `PASS=9`, `CASE_FAIL=0`, `RUNNER_ERROR=0`, and
`DETERMINISM=STABLE`. A runner error remains a harness defect, never a green
save result.

This test-only migration does not change Input, parser, business, storage, the
WechatSI adapter, capture/readiness logic, or ASR behavior.
