# Real-reader zero-count audit correction

Base: `c424e9e17559ead84b679bbb51b294ce5654cb90`.
Independent RED tests: `acad4ee095837f8d74819053ed0b6269f70a81ef`, cherry-picked
as `26447a56da3ec2cdffa116698f0f52a3e3582f65`. Isolated worktree: `ikpk-audit-counts-fix`.
Date: 2026-09-19. Implementation executor: Codex, separate from the independent
review/RED author. No GitHub writes, real host access or publication occurred.

The CI reader and local Vitest adapter retain validated zero counts in a small
typed error. The runner/coordinator consume its numeric metadata without parsing
exception text or storing report contents. CI refusal counts all three readable
fixed reports, so one empty report cannot mislabel a nonzero total as zero. A
missing/invalid CI count leaves the total unknown. An empty later local group
preserves counts from completed earlier groups. Publication still refuses zero
tests; no authorization or publication policy was relaxed.

## Verification

Independent RED was reproduced before editing: **2 failed, 1 passed**. Both
failures specifically lacked the required zero counter. Original raw output:
`operator-audit-reader-review-red.log`.

From `web/`:

```sh
./node_modules/.bin/vitest run tests/manual-publication-audit-reader-review.test.ts --reporter=verbose
./node_modules/.bin/vitest run tests/manual-publication-audit-reader-review.test.ts tests/manual-publication-launcher.test.ts tests/manual-publication-worker.test.ts tests/manual-publication-runner.test.ts tests/manual-publication-runner-review.test.ts tests/manual-publication-local-checks.test.ts tests/manual-publication-adapters.test.ts tests/manual-publication-ci-reader.test.ts
./node_modules/.bin/eslint scripts/lib/publication-report-error.ts scripts/lib/publication-ci.ts scripts/lib/publication-check-adapters.ts scripts/lib/publication-checks.ts scripts/lib/publication-runner.ts tests/manual-publication-audit-reader-review.test.ts
npm run typecheck
```

- Reader regressions: **7 passed**, raw output in
  `operator-audit-reader-counts-green.log`. Includes the original positive control,
  both zero regressions, total preservation and unknown/malformed count cases.
- Combined focused suite: **143 passed, 1 failed**. All original 99 audit cases,
  15 CI-reader cases and seven real-reader regressions passed. The sole failure is
  the separate readiness RED already in the base: adapter test
  `active readiness uses the explicit endpoint mode and shop rather than inferring
  them from CRM mode` expects `PUBLICATION_PAYMENT_READY_RESPONSE_FILE`.
- Changed-file ESLint and repository `git diff --check`: exit 0.
- Typecheck: five errors, all in
  `tests/manual-publication-remote-readiness-adapter.test.ts`, because the base
  `PublicationAdapterRuntime` does not yet declare `paymentReadiness`. No diagnostic
  identifies the count correction. The parent executor owns readiness wiring and
  will validate the integrated revision. Seven unrelated hints remain.

Dependencies were APFS-cloned into this worktree; no dependency directory was
shared for writes. This bounded correction does not claim complete publication
acceptance or replace the required independent review of the integrated revision.
