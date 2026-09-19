# Installed rollback CLI and operator — GREEN

Implementation: `codex/installed-rollback@d8de9b67fbc60b938f06c307d4a0f5488ef9eeb4`.
Independent RED: `manual-publication-installed-rollback-red.md`; root-authored supplemental active-role and protected-config tests were integrated before their fixes. Original delivery: 3 pass / 35 fail. Active-role additions were observed locally as 19 pass / 2 fail before the held-session binding and role mismatch refusal.

## Implemented

- Existing dependency-free launcher dispatches rollback to fixed repositoryless `runtime/web/scripts/publication-operator.ts`, validating arguments, adjacent protected configuration, runtime directories, worker and version-1/full-SHA manifest before credential delivery. It does not fetch main or install dependencies.
- The operator validates protected context before loading installed dependencies; it binds the real state store, rollback coordinator, retained transport and fixed three-group checks. Only the coordinator selects the original indexed publication; original deploy/payment roles drive retained checks.
- Active payment roles require matching protected payment configuration. Readiness uses the already-held retained transport session; authorization is available only during non-ci checks and is revoked before switching and after completion.
- Builtin-only config/audit helpers are shared with the existing publish worker. Rollback audit uses the original commit and selected release ID, counts fresh rollback groups, keeps original CI counts and preserves typed check/active-unindexed refusals. Raw logs and reasons are not audit input.
- Protected config preserves production's prohibition on `demoForms: stub` and requires at least five retained releases.

## Verification

From repository root:

```sh
node --test scripts/tests/publication-launcher*.test.mjs scripts/tests/publication-transport-authorization.test.mjs scripts/tests/publication-transport-retained.test.mjs
```

**51 passed, 0 failed.** Includes native installed-worker/broker positive controls, hostile arguments/runtime paths/audits, original transport authorization and actual retained byte transfer.

From `web/`:

```sh
./node_modules/.bin/vitest run tests/manual-publication-operator-rollback.test.ts tests/manual-publication-worker.test.ts tests/manual-publication-rollback.test.ts tests/manual-publication-runner.test.ts
./node_modules/.bin/eslint scripts/publication-worker.ts scripts/publication-operator.ts scripts/publication-context.ts scripts/publication-audit.ts scripts/lib/publication-rollback.ts scripts/lib/publication-runner.ts tests/manual-publication-rollback.test.ts
./node_modules/.bin/tsc --noEmit --allowImportingTsExtensions --module nodenext --target es2022 --skipLibCheck scripts/publication-worker.ts scripts/publication-operator.ts scripts/lib/publication-rollback.ts tests/manual-publication-operator-rollback.test.ts tests/manual-publication-rollback.test.ts
```

**82 passed, 0 failed; focused ESLint and TypeScript passed.** The supplemental authorization regression tests ci/stand/prod, rejects probes before and after checks, rejects foreign destinations and verifies successful index append. No production SSH, CMS, Actions or payment service was contacted.

## Named negative mutation

At the committed implementation above, replace the single expression in `scripts/publication-launcher.mjs`:

```diff
- ...(rollback ? { releaseId: (value) => value === releaseId } : {}),
+ ...(rollback ? { releaseId: (value) => typeof value === 'string' } : {}),
```

Then run:

```sh
node --test --test-name-pattern='rollback audit refuses wrong release' scripts/tests/publication-launcher-rollback.test.mjs
```

The named test `rollback audit refuses wrong release, unknown fields, wrong operation kind, zero checks and malformed output` changes from **1 pass / 0 fail** to **0 pass / 1 fail** because the foreign-release audit incorrectly succeeds. Restore the committed file and rerun: **1 pass / 0 fail**. Restoration was verified with empty `git status --porcelain` and `git diff --exit-code d8de9b67fbc60b938f06c307d4a0f5488ef9eeb4` before adding this evidence.

## Boundaries

Installation ownership/parent hardening and dependency provisioning remain `server-hardening` work. Recovery/accept-state implementation is a separate delivery. Production acceptance and the change's independent full reviews remain pending in the parent task. Existing source artifact `ikpk-manual-publication-adapters/web/dist` was not changed. Dependencies used an isolated APFS copy in this worktree; no shared working directory was written.
