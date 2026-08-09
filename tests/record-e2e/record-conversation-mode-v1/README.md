# Record Conversation Mode V1 contracts

This test-only suite freezes the R1A product boundary: `AUTO_REVIEW`, `CLARIFYING`,
`CONFIRMING`, and `SAFE_BLOCKED` must be mutually exclusive user surfaces. It does
not prescribe a `conversationPhase` variable and it does not implement production
behavior.

Evidence layers:

- `STATIC_WXML`: a quote-aware WXML tree checks for one top-level mutually-exclusive
  branch chain. Scattered field-level `!activeQuestion` guards cannot satisfy it.
- `RENDERED_WXML`: a test-only evaluator applies real PageVM data to ancestor
  `wx:if/elif/else`, `hidden`, and `disabled` attributes. Route labels are never used
  to infer visibility.
- `PAGE_VM`: the real production Page, controlled network, production question input
  and tap handlers, proof flow, business counters, and storage counters are observed.

Fixtures may provide only original text, controlled transport outcomes/responses,
and real user actions. They may not call `page.setData`, inject a phase, activeQuestion,
save eligibility, route, or proof.

`CONV-006/007` deliberately require the answer-to-`AUTO_DEEP` transition to issue a
real `/api/ai/parse/deep` request. Missing requests are `CASE_FAIL`, not runner errors.
The request must carry normal request identity and a canonical textual user supplement
that the real `server/src/server.js` route decision independently classifies as
`AUTO_DEEP`, while the immutable original text remains separately preserved. A
test-only loader executes that production decision function without binding a port;
trusting a client route, `localDraft`, or a controlled success response is insufficient.

Run:

```sh
node tests/record-e2e/record-conversation-mode-v1/run.js --repeat 2
```

Exit codes: `0` all contracts pass, `1` frozen stable RED, `2` runner failure,
determinism drift, green-control failure, or unexpected baseline drift.

This phase does not run real WeChat rendering. `REAL_WXML=NOT_RUN_THIS_PHASE` is
reported explicitly; the WXML layer here is a structural/visibility evaluator, not a
DevTools or device claim.
