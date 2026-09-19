# Installed recovery and CMS acceptance — independent RED

Implementation base: `codex/manual-publication-implementation@f1ea0229cd273f474f223cf5bee2f4065b3bed42`. Tests and evidence only; no implementation changes. Executor inherited the parent Codex model; implementation is assigned to another executor.

## Approved scope and concrete binding contract

Approved change `manual-publication-only`, `cms-content-source/spec.md` lines 27–43 and 103–116, tasks 5.1a and 5.2 require restoration of the publication index and explicit persisted acceptance of restored CMS state. `deploy-gating/spec.md` requires an installed trusted mechanism and keeps credentials out of argv/output. The parent accepted the concrete command/API contract below before tests were written.

- Reuse the installed rollback convention: adjacent protected `runtime/runtime.json` contains `{version:1,commit:<40 lowercase hex>}`; fixed native entry `runtime/web/scripts/publication-operator.ts`, invoked with `process.execPath`, cwd `runtime/`. Existing protected context plus `PUBLICATION_RUNTIME_SHA`; no fetch/checkout of main or source override.
- `recover --config PATH` invokes fixed installed `runPublicationOperator({argv,env,cwd})` with `argv: ['recover']`. Bind existing `createSshTransport(...).recover({recordIndex})`. Its record callback verifies the actual served pair using `verifyServedPublication(operation, new URL(config.siteUrl), fetch)` **before** real `state.appendPublication`, under the existing transport lock. Original pending operation/evidence is preserved; callback substitution is rejected. Recovery authorization permits only destination-scoped connect/recover, binds the full operation, excludes stage/activate/rollback, and expires after the operation.
- Pending prepared operations may be cancelled without a publication record. No pending operation is a no-op. `committing` with old current release remains a named refusal requiring manual repair; these tests do not invent a repair command or require automatic roll-forward.
- `accept-state --config PATH --observed-entry N --fingerprint F --confirm` invokes the same fixed entry without `--config` in worker argv. Bind real `state.acceptState({expectedObservedEntry:N,fingerprint:F,actor:config.actor})`. Operator identity comes only from protected config. No CMS/build/CI read or release transport is required. A newer CMS event invalidates the old confirmation. The next journal entry makes the accepted state eligible without another confirmation.
- Typed FD3 audits: `recovered` contains original commit/snapshot/release/digest/publication ID, positive revision and local/CI counts; `recovery-noop` and `recovery-cancelled` contain no published-pair claim. `state-accepted` contains `observedEntry` equal to explicit N and `revision` equal to N+1, with no invented commit/snapshot. Refusals: `recovery-failed` and `accept-state-failed`. Unknown audit fields and stale/invalid acceptance numbers refuse as `invalid-worker-audit`. Raw worker stdout/stderr are suppressed, including a credential canary.

## Reproduction and results

From worktree root:

```sh
node --test scripts/tests/publication-launcher-recovery.test.mjs > scripts/tests/publication-launcher-recovery-red.log 2>&1
```

15 executed: **1 PASS, 14 FAIL**. The native broker/worker positive control passes. Both installed commands currently refuse as `untrusted-ref`, because the base launcher accepts only publish. Audit-negative tests require an actual worker marker before testing the audit rejection; early refusal cannot count as audit validation.

From `web/`:

```sh
./node_modules/.bin/vitest run tests/manual-publication-operator-recovery.test.ts --reporter=json --outputFile=tests/evidence/manual-publication-operator-recovery-red.json > tests/evidence/manual-publication-operator-recovery-red.log 2>&1
./node_modules/.bin/eslint tests/manual-publication-operator-recovery.test.ts
./node_modules/.bin/tsc --noEmit --skipLibCheck --target es2022 --module esnext --moduleResolution bundler --allowImportingTsExtensions --esModuleInterop --types node,vitest/globals tests/manual-publication-operator-recovery.test.ts
```

17 executed: **3 PASS, 14 FAIL**. All fourteen fail at the explicit missing fixed-operator assertion, outside rejection assertions. Lint and focused TypeScript check pass.

Passing positive controls:

1. Real temporary bare Git remote and shared state store persist acceptance, lift the observed revision to 4, and reject reuse of confirmation for entry 3; the publication index remains unchanged.
2. Real served-pair verifier reaches the fixture, accepts the exact pair and rejects a wrong commit.
3. Real state validator durably appends original evidence and rejects an empty local-check group list.

## Coverage and limits

Native tests exercise installed path dispatch, exact arguments, trust-before-broker input rejection, typed audits and secret-output suppression. Vitest tests execute the real shared Git state store/ledger and real served-pair verifier; only remote transport and prohibited CMS/CI/check-adapter effects are fixtures. Recovery fixture models the existing transport lock/pending protocol, with positive authorization proof assertions.

The suite includes no-op/prepared cancellation, wrong served pair, invalid pending evidence, index-write failure, callback operation substitution, destination/operation-scoped expiring recovery authorization, stale acceptance and protected actor binding. Existing transport tests cover actual Python/SSH framing and crash recovery; existing state-store tests cover push races/retries. Their machinery is not reimplemented here.

This is RED evidence for the missing binding, not proof that the eventual implementation passes each negative case: those cases cannot reach their target until the operator exists. After implementation, rerun all tests and perform target-specific negative mutations; do not treat the missing-file failures as those mutations. No network service, real SSH host, CMS, GitHub operation or payment API was contacted.
