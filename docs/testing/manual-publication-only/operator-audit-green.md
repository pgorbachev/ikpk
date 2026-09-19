# Protected operator audit — implementation verification

Implementation: `implement/publication-fd3-audit@9b5d7545c64914233f286cf473b86ce5386454b6`.
Date: 2026-09-19. Executor: Codex implementation agent. Independent RED evidence:
`operator-audit-red.md` (nine failures, with a separate no-op producer sensitivity probe).

The installed launcher suppresses worker stdout/stderr and consumes only fd 3: one
JSON value, maximum 16 KiB, version 1, known codes/fields and typed values. The audit
commit must equal the freshly cloned canonical main. Success additionally requires
the selected pair, artifact digest, publication id, positive provenance and actual
positive local/CI counts. Invalid or absent audit fails closed, including worker exit 0.
Valid refusal audit remains available on the error while the launcher exits nonzero.

The builtin-only worker curator has no sink callback and never reads exception messages
or causes. The real check coordinator and publication runner attach structured metadata,
preserving actual zero/partial counts, stale provenance and the selected active pair
when recording fails. Unknown exceptions produce a generic refusal without invented
counts. The CLI emits only the curated record. Duplicate validation of the same
protected parent directory was removed: config.json and launcher are already required
to share that directory.

## Verification

From `web/`:

```sh
./node_modules/.bin/vitest run tests/manual-publication-launcher.test.ts tests/manual-publication-worker.test.ts tests/manual-publication-runner.test.ts tests/manual-publication-runner-review.test.ts tests/manual-publication-local-checks.test.ts
npm run lint
npm run typecheck
```

Results: **99 passed**, five files; lint exit 0; typecheck exit 0, zero errors/warnings,
seven existing hints. Supplemental tests cover the actual native worker CLI fd3 refusal,
real coordinator partial/zero counts, configured public site origin independent of SSH
target, and missing/invalid origin refusal before installation.

From `scripts/`: `npm run lint && npm run typecheck` — exit 0.
From repository root: `node --test scripts/tests/publication-launcher-agent.test.mjs`
— one passed, confirming broker agent socket continuity with suppressed output.
`git diff --check` — exit 0.

`./bin/check-spec-refs` — exit 1 with 16 existing shifted references to deploy-web.sh,
repo-hygiene.test.ts and browser-test-gating.test.ts, outside this delivery. The parent
integration task owns their reconciliation. No build was repeated for this audit-only
delivery; the parent task owns combined build verification.

## Negative mutation

After committing the implementation, apply in this isolated worktree:

```sh
python3 - <<'PY'
from pathlib import Path
p = Path('scripts/publication-launcher.mjs')
s = p.read_text()
old = 'commit: (value) => value === commit,'
assert s.count(old) == 1
p.write_text(s.replace(old, "commit: (value) => typeof value === 'string',"))
PY
cd web
./node_modules/.bin/vitest run tests/manual-publication-launcher.test.ts -t 'rejects a wrong commit'
```

Before: named test passed in the 99-test run. After: **one failed**, 35 intentionally
filtered tests skipped; the named test observed exit 0 and status success for the wrong
commit instead of refusal. Thus the test detects removal of the actual commit binding.

Restoration from repository root:

```sh
git restore --source=9b5d7545c64914233f286cf473b86ce5386454b6 -- scripts/publication-launcher.mjs
git status --porcelain
git diff --exit-code 9b5d7545c64914233f286cf473b86ce5386454b6
```

Both outputs empty; diff exit 0 before this evidence file was written.

## Boundaries

The success producer runs the real worker and runner with external effects doubled;
the installed launcher transport tests use a committed fixture worker. The native CLI
test exercises a real early refusal. These are separate boundaries, not a complete
real-success CLI lifecycle. No real CMS capture, GitHub write, SSH publication or
production deployment occurred. Recovery of an older pending operation is outside
this new-publication runner and is not claimed as covered. Independent code review
and combined-task acceptance remain with the parent task.
