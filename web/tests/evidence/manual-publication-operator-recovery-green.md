# Installed recovery and state acceptance — implementation evidence

Implementation: `codex/operator-recovery@2d98e76761b9d9fdce1a21874120299c37dfcda0`.
Base: `codex/manual-publication-implementation@08f0fe92a3af60132925c35d82b5943b09b4a66f`.
The implementation executor is separate from the independent RED author. This is a bounded
implementation handoff, not independent review or operational acceptance. No production,
SSH host, CMS, GitHub, installer, source checkout or old CI run was contacted.

## Behavior

- The installed launcher accepts only `recover --config PATH` or
  `accept-state --config PATH --observed-entry N --fingerprint F --confirm`, with
  protected runtime validation before the credential broker. No caller-supplied actor,
  operation, evidence or source override is accepted.
- Recovery uses the existing transport host lock. It binds and clones the complete pending
  operation, validates its original CI/local evidence, permits only connect/recover for the
  configured destination, and expires authorization on success or failure. Its callback
  requires the exact operation, verifies the served pair and health at the protected site
  before appending through the real shared Git store. Original evidence is preserved.
- No-op and prepared cancellation produce no index write or publication-pair claim.
  Existing committing-old/manual-repair transport refusals remain unresolved and do not
  become an invented automatic repair. The installed FD3 interface intentionally emits
  the approved generic `recovery-failed` code; it does not expose raw exception messages.
- Acceptance invokes `state.acceptState` with the explicit observed entry/fingerprint and
  protected configuration actor. No release transport, CMS, build or current/old CI is used.
  Existing state-store confirmation races remain authoritative.
- Typed audits distinguish recovered publication, no-op, cancellation and acceptance. A
  recovered publication emits its original identity/revision and evidence counts; recovered
  rollback counts use the pending rollback checks. Acceptance emits only observed N and
  revision N+1. Launcher discards all raw worker stdout/stderr and rejects unknown fields.

## Independent RED and fixture correction

The supplied RED evidence recorded native **1/15 PASS** and operator **3/17 PASS** before
implementation. With the binding implemented, one operator success case failed only in the
full suite (it passed alone). Instrumentation showed a stale transport mock from a prior
`fixture(false)` control paired with current fetch/state. The controls registered mocks that
were never consumed. The fixture now registers mocks/global fetch only when loading the
operator; control paths continue using their real explicit ports. No assertion was removed
or relaxed. The full independent operator suite now passes **17/17**.

Additional audit tests exposed two real integration gaps before their fixes: copying extra
provenance/check fields would violate the recovered audit schema, and recovered rollback
counts initially used original publication checks. Their RED was **3 PASS / 2 FAIL**; after
fixes the same five tests pass **5/5**.

## Verification

From repository root:

```sh
node --test scripts/tests/publication-launcher-recovery.test.mjs scripts/tests/publication-launcher-rollback.test.mjs scripts/tests/publication-launcher-agent.test.mjs
(cd scripts && ./node_modules/.bin/eslint publication-launcher.mjs)
```

**35/35 native tests passed; launcher ESLint passed.**

From `web/`:

```sh
./node_modules/.bin/vitest run tests/manual-publication-operator-recovery.test.ts tests/manual-publication-operator-rollback.test.ts tests/manual-publication-recovery-audit.test.ts tests/manual-publication-launcher.test.ts tests/manual-publication-audit-reader-review.test.ts tests/manual-publication-worker.test.ts --reporter=verbose
./node_modules/.bin/eslint scripts/publication-operator.ts scripts/publication-audit.ts tests/manual-publication-operator-recovery.test.ts tests/manual-publication-recovery-audit.test.ts
./node_modules/.bin/tsc --noEmit --strict --allowJs --skipLibCheck --target es2022 --module esnext --moduleResolution bundler --allowImportingTsExtensions --esModuleInterop --types node,vitest/globals scripts/publication-operator.ts scripts/publication-audit.ts tests/manual-publication-operator-recovery.test.ts tests/manual-publication-operator-rollback.test.ts tests/manual-publication-recovery-audit.test.ts
```

**116/116 tests passed; relevant ESLint and strict TypeScript passed.** `--allowJs` is needed
for this repository's declaration-free `.mjs` launcher/transport imports; without it strict
TypeScript reports TS7016 on six existing native-JS boundaries rather than checking them.
The final harmless curator type-guard adjustment was followed by its five-test suite and
ESLint, both green. No site output changed, so no browser/build parity claim is made here.

## Named negative checks

All mutations ran in a separate disposable worktree at the implementation SHA. The exact
single replacements, cwd, commands and target names are stored in
`manual-publication-operator-recovery-mutations.json`. For each case the target passed
**1/1** before mutation and failed **1/1** after mutation:

1. Remove served-pair verification → `served-mismatch retains unresolved pending state...`.
2. Remove callback operation comparison → `substituted-record retains unresolved pending state...`.
3. Keep recovery authorization usable after return → authorization-expiry assertion.
4. Remove allowed-action restriction → ordinary stage/activate/rollback authorization assertion.
5. Remove request destination restriction → foreign destination authorization assertion.
6. Remove full-operation restriction → substituted operation authorization assertion.
7. Replace protected actor with `spoofed` → explicit-confirmation actor assertion.
8. Accept any integer observed entry in FD3 audit → acceptance-audit binding assertion.
9. Copy unrelated recovered provenance fields → real publication shape audit assertion.
10. Use original local counts for recovered rollback → pending rollback audit count assertion.

Cases 3–6 independently fail the named `recovery authorization excludes ordinary mutations
and expires after use` test at their respective guard. Restoration after every mutation was
verified with empty `git status --porcelain` and `git diff --exit-code` against the full
implementation SHA. The disposable worktree was then removed. No mutated file is delivered.
