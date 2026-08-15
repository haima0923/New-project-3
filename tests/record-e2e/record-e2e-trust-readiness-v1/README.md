# Record E2E Trust Readiness V1

This directory is a test-only readiness layer. It does not replace or copy Core120.

It adds:

- a failure taxonomy and PASS / EXPECTED_RED / UNEXPECTED_RED / SPEC_REQUIRED / RUNNER_ERROR projection;
- public-business probes for audited P0 save-boundary gaps;
- local-parser cases for Voice transcript shapes that were missing from Core120;
- three explicit `SPEC_REQUIRED` cases where project documents and current contracts disagree;
- separate P0 redline and failure-cluster summaries.

The current V1 corpus is intentionally smaller than the suggested 150–250 range: 120 existing Core cases, 19 non-duplicate supplemental executable cases, and 3 spec-decision cases. Low-value paraphrase padding was not added.

Run from the repository root with the bundled or system Node runtime:

```sh
node scripts/validate-record-e2e-corpus.js
node scripts/run-record-e2e-headless.js --all --repeat 2 --output /private/tmp/record-e2e-trust-core120.json
node tests/record-e2e/record-e2e-trust-readiness-v1/run.js \
  --core-report /private/tmp/record-e2e-trust-core120.json \
  --repeat 2 \
  --output /private/tmp/record-e2e-trust-readiness-v1.json
```

Reports are intentionally written outside the repository. Core execution uses real production page JavaScript inside PageVM, Fake wx, guarded network, and isolated storage. It is not WXML/DOM, real AI, real WechatSI, or real-device evidence.

`EXPECTED_RED` is not a waiver. It means the assertion completed and exposed a product/contract difference. A later comparator can use this frozen report: a former PASS becoming red, or a red case changing failure signature/layer, is `UNEXPECTED_RED`.
