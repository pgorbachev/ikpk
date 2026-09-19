# Independent review: protected operator audit and SSH probes

Reviewed revision: `7b15c4a237b65efaf26edce3dfbf2248ea09b331` (integration
containing audit `249be0c8f1175ad4d71bbad9e6a7608968b24d04` and probes
`6e6c512f92e5db45f784851ade18a2e4704eb05c`). Review date: 2026-09-19.
Executor: independent Codex review agent, separate from both implementations,
using the inherited strongest available model. Worktree:
`/private/tmp/ikpk-audit-probes-review`, branch `review/audit-probes-7b15c4a`.
No production implementation changes, GitHub writes or real host access.

## Finding: P2 — actual zero-count refusals lose their counts before the audit boundary

The refusal remains safe, but the installed operator result cannot distinguish a
known zero-test result from an unreadable/unknown report. This misses the explicit
zero-count diagnostic requirement in `manual-publication-only` task 2.3 and the
deploy-gating scenario “публикующий прогон не выполнил ни одной проверки”.

Two actual producer paths exhibit the same gap at the reviewed revision:

- `web/scripts/lib/publication-ci.ts:113` throws for a zero-count report before
  returning evidence. `web/scripts/lib/publication-runner.ts:62` therefore never
  reaches the assignment of `ciExecutedTests`. The worker audit contains
  `code: ci-failed` but omits `ciExecutedTests: 0`.
- `web/scripts/lib/publication-check-adapters.ts:107` throws for a well-formed
  empty Vitest report. The coordinator awaits the effect at
  `web/scripts/lib/publication-checks.ts:93` before `requireResult` can observe its
  count. The worker audit contains `checks-failed` / `snapshot-provenance` but
  omits `localExecutedTests: 0`. A nonzero process exit also throws before reading
  any emitted reporter file; the new RED case specifically isolates an empty
  parsed report with a completed process.

The existing tests pass synthetic returned zero-count evidence to the runner or
coordinator. The new tests instead use the actual CI reader and actual check
adapter, doubling only HTTP/report acquisition and external process execution.
Both run through `createWorkerAudit`. The CI test also verifies that no transport
is opened. A positive control confirms these exact reader paths count 31 CI tests
and three local assertions when reports contain successful results.

Suggested correction: carry typed, validated counts on report-validation failures
through the existing audit metadata path; do not parse arbitrary error messages or
invent zero for unreadable reports. This review makes no production fix.

## Full-pass coverage and result

No new P0/P1 found in the assigned scope. Read the complete launcher, native worker,
runner, check coordinator, SSH transport and remote helper, plus CI/adapter producer
boundaries and related tests. Checked:

- one bounded fd3 JSON record, strict installed allowlist, canonical commit binding,
  success prerequisites, exit/status agreement, and suppressed stdout/stderr;
- safe worker curation without exception/cause text, stale provenance metadata and
  active-pair preservation after index failure;
- source/destination authorization for connection and each read probe, complete proof
  before upload/activation/rollback/retained-read/recovery mutation;
- probe-only sessions creating no releases, current, pending or redirect changes;
- fixed nginx argv without a shell, bounded stdout file, command timeout, bounded
  non-symlink regular redirect reads;
- fixed loopback readiness GET, disabled environment proxies and redirects, socket
  timeout, bounded response body, HTTP metadata preserved as observations.

The known unfinished worker-to-remote-readiness wiring, installed rollback runtime,
retention, redirect application, recovery repair, source/machine permission
preconditions and production infrastructure were excluded as assigned. This is
not evidence of a complete live successful publication lifecycle.

## Reproduction and verification

From `web/`:

```sh
./node_modules/.bin/vitest run tests/manual-publication-audit-reader-review.test.ts
./node_modules/.bin/vitest run tests/manual-publication-launcher.test.ts tests/manual-publication-worker.test.ts tests/manual-publication-runner.test.ts tests/manual-publication-runner-review.test.ts tests/manual-publication-local-checks.test.ts
./node_modules/.bin/eslint tests/manual-publication-audit-reader-review.test.ts
```

New review tests: **2 failed, 1 passed**, both failures specifically missing `0`
counter fields. Raw output: `operator-audit-reader-review-red.log`.
Existing focused audit tests: **99 passed**. ESLint: exit 0.

From repository root:

```sh
node --test scripts/tests/publication-serving-probes.test.mjs scripts/tests/publication-transport*.test.mjs
git diff --check
```

Existing probe/transport tests: **84 passed**. Diff check: exit 0. Dependencies were
APFS-cloned into this isolated worktree, not shared for writes. No broad build or
production acceptance is claimed for a review-only delivery.

## Separate overcomplexity pass

No material production-code removal or replacement with a standard mechanism is
recommended in this bounded diff. The installed schema duplicates some worker
validation deliberately across the trust boundary; removing that duplication would
let repository data define the installed audit contract. Fixed probe methods and
their separate authorization checks have distinct externally observable purposes.
The standard subprocess, file-descriptor and urllib mechanisms already provide the
required bounded operations without a new general command framework.
