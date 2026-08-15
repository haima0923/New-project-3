# Voice → Record Evidence Boundary V1

This deterministic, offline PageVM suite freezes the provenance boundary from a
valid WechatSI final callback through the shared hold controller, one-shot entry
handoff, `input.onShow()`, and Record intake.

It deliberately does not test real microphone audio, real WechatSI recognition
quality, WXML rendering, real AI, or business persistence. The existing Voice
lifecycle and Save Truth suites remain the authority for those frozen layers.

Each case runs in an isolated Node worker so the process-global WechatSI session
and the parser's session validator always refer to the same production module
instance. This is test isolation, not a replacement for the production session
contract.

The contract uses these semantics:

- `source` is the input modality: `voice`, `typed`, or the existing clipboard
  value `paste`;
- `originSurface` identifies `DASHBOARD_HERO` or `CUSTOM_TAB_CENTER` for the two
  shared hold-to-talk entry points;
- a valid completed Voice handoff carries the existing session-issued
  `voiceCompletionEvidence` without inventing a second session identifier;
- missing evidence follows the existing `MARK_UNVERIFIED` route contract: it
  cannot obtain verified-Voice or Voice Standard eligibility and creates no
  automatic write; stale or transcript-mismatched evidence is rejected by the
  existing session validator;
- evidence is intake provenance and must not become a business record field.

Run from the repository root:

```sh
node tests/record-e2e/voice-record-evidence-boundary-v1/run.js --repeat 2
```

Before the production boundary patch, VRE-001/002/006 are frozen
`EXPECTED_RED`; all other cases must remain green and `RUNNER_ERROR` must be 0.
After the patch, all ten cases must pass.
