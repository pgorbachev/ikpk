# Operator audit channel: independent RED evidence

Test revision: `codex/publication-audit-red@25bea4610255a7841bf83bb45ba61f8cc546dcd6`.
Implementation under test: `codex/manual-publication-implementation@82d944894899f99ab30d5370f33a70d8d555765a`.
Date: 2026-09-19. Executor: independent Codex test agent; implementation handed back to the parent executor.

Scope is the accepted `manual-publication-only` diagnostics: actual executed counts,
provenance numbers on stale/regressed state, and the active pair when index recording fails.
Repository stdout/stderr and arbitrary exception/cause text must remain suppressed.
The protected launcher's audit record uses fixed fd 3, one JSON value, at most 16 KiB,
version 1, fixed codes and typed fields; invalid or absent records fail closed.

## Unmodified implementation

From `web/`:

```sh
./node_modules/.bin/vitest run tests/manual-publication-launcher.test.ts tests/manual-publication-worker.test.ts
```

Result: exit 1; **9 failed, 46 passed, 55 executed**. All 46 pre-existing tests pass.
All nine added tests fail. Full output: `operator-audit-red.log`.

The four launcher tests establish missing success/refusal audit data and acceptance of
invalid/missing audit after a zero worker exit. The invalid cases use soft assertions so
all malformed, missing, unknown-code, oversized, wrong-commit, invalid-type, unknown-field,
and negative-count inputs are actually executed. The oversize case is an otherwise valid
record followed by 16 KiB of JSON whitespace, separating size validation from syntax validation.
Both stdout and stderr contain a deliberately emitted canary; the assertions forbid it
in the launcher result. Existing positive fixtures emit fd 3 when available and tolerate
only absent-descriptor errors on the old launcher.

The five producer tests import the fixed worker module. Four use its real runner:
success, all local groups executing zero checks, stale state, and failure after activation.
Only external effects are doubled. The fifth checks unknown/forged exception text.
The baseline lacks `createWorkerAudit`, so its missing-export assertion is followed by
an additional sensitivity probe below.

## Existing API with empty behavior

Temporarily append this exact stub to `web/scripts/publication-worker.ts` at the test revision:

```ts
// TEMPORARY RED sensitivity probe; removed before commit.
export function createWorkerAudit() {
  return { version: 1, status: 'refused', code: 'publication-failed' };
}
```

Then run from `web/`:

```sh
./node_modules/.bin/vitest run tests/manual-publication-worker.test.ts
```

Result: exit 1; **4 failed, 15 passed, 19 executed**. Full output:
`operator-audit-noop-red.log`. The successful-operation identity/counts, zero-count refusal,
stale-state provenance and active-pair tests fail on their actual evidence assertions.
The unknown-error generic refusal passes. Thus an existing function returning a blanket
refusal cannot satisfy the new useful-audit contract.

Restore and verify before writing this evidence:

```sh
git restore --source=25bea4610255a7841bf83bb45ba61f8cc546dcd6 -- web/scripts/publication-worker.ts
git status --porcelain
git diff --exit-code 25bea4610255a7841bf83bb45ba61f8cc546dcd6
```

Both restoration outputs were empty; diff exited 0. No implementation changes are retained.

## Other local verification

- `web/node_modules/.bin/eslint` on both changed TypeScript test files: exit 0.
- `node --test scripts/tests/publication-launcher-agent.test.mjs`: 1 passed, exit 0.
- `git diff --check`: exit 0.

No build, real CMS, GitHub write, SSH deployment, or publication was performed.
The full real-worker CLI lifecycle is not reproduced here: producer behavior and fd transport
are tested at their separate executable boundaries, using the real runner for producer evidence.
